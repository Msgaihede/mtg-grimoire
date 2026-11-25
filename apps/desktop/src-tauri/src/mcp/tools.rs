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
//! answer, exactly as the page's `graphql_query` would get it. `read_guide` answers any of the
//! server's prompts (`prompts.rs`) as text, for a client that runs one only when the user picks it.
//! **No tool writes the reader's collection, wishlist or decks** (the owner's decision, 2026-10-31,
//! which retired issue #1396's three adds): an agent finds and explains, and the reader makes the
//! change in the app, which is open.
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
    // Changes what one window shows, never any data.
    let show = json!({
        "readOnlyHint": false,
        "destructiveHint": false,
        "idempotentHint": true,
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
    let list_variant = json!({
        "type": "string", "enum": ["live", "theory"],
        "description": "The deck's actual list (live, the default) or its theory list.",
    });
    let document = json!({
        "type": "string",
        "description": "A GraphQL query document over the schema graph_schema answers.",
    });
    let syntax = json!({
        "type": "string",
        "maxLength": grimoire_core::query_language::MAX_SYNTAX_CHARS,
        "description": concat!(
            "A Scryfall search, e.g. \"t:goblin cmc<=2 -is:token\" or ",
            "\"(o:draw or o:scry) id<=ur\"; ANDed with the other arguments. read_guide's ",
            "scryfall_syntax has the keywords; a term this app cannot apply as written is ",
            "refused, naming it."
        ),
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
            "Search the card database (every Magic card, not just the user's) by name and by the \
             Search page's filters. Answers printings with their Scryfall ids (cardId), which \
             get_card takes. By default one printing per card; set allPrintings to choose a \
             specific set's printing. Give query, syntax (a Scryfall search), filters, or any \
             of them together. Oracle tag slugs for filters.oracleTags come from find_tags; \
             format keys from format_rules.",
            json!({
                "query": { "type": "string", "description": "Words of the card's name." },
                "syntax": syntax.clone(),
                "set": { "type": "string", "description": "Only this set code, e.g. \"lea\"." },
                "allPrintings": { "type": "boolean", "description": "Every printing rather than one per card." },
                "limit": { "type": "integer", "minimum": 1, "maximum": 50, "description": "How many to answer (default 10)." },
                "filters": {
                    "type": "object",
                    "description": "The Search page's filter bar. Every field is optional; a card must pass all of them.",
                    "properties": filter_properties(),
                    "additionalProperties": false,
                },
            }),
            &[],
            &read,
        ),
        tool(
            "show_search",
            "Show a search in the app",
            "Show a search on the MTG Grimoire app's Search page, in the window the user last \
             used, and bring that window forward. Ask the user in chat first (\"Want to see \
             these in the app?\") and call this only after they say yes, once per yes. Changes \
             no data. text is the Search box's text in Scryfall syntax (t:, o:, kw:, pow>=4, \
             otag:, -, or, parentheses); filters are find_cards' filters plus borders, finishes \
             and universe, and find_cards with the same filters previews the count. Answers \
             what the page shows: total, the keywords it read, the words it searched as plain \
             text (words) and any unknownTags; cameForward false means Windows kept the app \
             behind and its taskbar button is flashing.",
            json!({
                "text": { "type": "string", "maxLength": super::show::MAX_TEXT_CHARS, "description": "The Search box's text, in Scryfall syntax." },
                "filters": {
                    "type": "object",
                    "description": "The Search page's filter bar. Every field is optional; the page applies all of them.",
                    "properties": show_filter_properties(),
                    "additionalProperties": false,
                },
                "sort": {
                    "type": "object",
                    "description": "How the page orders the results (default: the page's own).",
                    "properties": {
                        "key": { "type": "string", "enum": super::show::SORT_KEYS },
                        "descending": { "type": "boolean", "description": "Largest first (default false)." },
                    },
                    "required": ["key"],
                    "additionalProperties": false,
                },
                "allPrintings": { "type": "boolean", "description": "Every printing rather than one per card." },
            }),
            &[],
            &show,
        ),
        tool(
            "get_card",
            "Get card",
            "One printing's details: oracle text, type, mana cost, the finishes it was made in, \
             its legalities and market prices, how many the user owns, its faces, its oracle \
             tags (direct ones, with tagData saying when the tag list was downloaded), the cards \
             it brings with it (related: tokens, emblems, meld parts, combo pieces; at most 25, \
             with relatedTotal giving the full count when there are more; comboPiece is \
             Scryfall's word for cards that refer to each other, not a Spellbook combo, which \
             card_combos answers) and how many Commander Spellbook combos name it. Prices are \
             in the reader's marketplace.",
            json!({ "cardId": card_id }),
            &["cardId"],
            &read,
        ),
        tool(
            "search_collection",
            "Search collection",
            "The cards the user owns, filtered by name words, a Scryfall search (syntax) and \
             optionally one folder. Each row is one printing, finish and condition in one \
             folder, with its quantity.",
            json!({
                "query": { "type": "string", "description": "Words of the card's name; omit for everything." },
                "syntax": syntax.clone(),
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
            "The cards the user wants, filtered by name words, a Scryfall search (syntax) and \
             optionally one wishlist folder. Free text here matches part of the card's name.",
            json!({
                "query": { "type": "string", "description": "Words of the card's name; omit for everything." },
                "syntax": syntax,
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
            "The user's folders in the collection, the wishlist or the deck list, with their ids — \
             what search_collection and search_wishlist take as folderId. A collection folder of \
             kind other than \"user\" belongs to a deck.",
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
            "card_combos",
            "A card's combos",
            "Combos that name a card, from Commander Spellbook's list (Commander-legal combos \
             only: a combo needing a card banned in Commander is not in it). Each is short: \
             comboId, the cards, what it produces, its bracket, how many unnamed cards (templates) \
             it also needs and its popularity; get_combo has the steps. Answers total, matching \
             (after the filters), ownedTotal, sizes (combos by number of cards) and comboData.",
            json!({
                "cardId": card_id.clone(),
                "search": { "type": "string", "description": "A piece's name, or part of it." },
                "produces": { "type": "string", "description": "Words in what the combo produces, e.g. \"infinite mana\"." },
                "cardCount": { "type": "integer", "minimum": 1, "description": "Only combos of this many cards." },
                "ownedOnly": { "type": "boolean", "description": "Only combos whose every card the user owns." },
                "limit": { "type": "integer", "minimum": 1, "maximum": 50, "description": "How many to answer (default 10)." },
                "offset": offset.clone(),
            }),
            &["cardId"],
            &read,
        ),
        tool(
            "get_combo",
            "Get combo",
            "One combo from Commander Spellbook's list (Commander-legal combos only) whole: its \
             cards, the steps, the prerequisites, the templates it also needs, the mana, what it \
             produces and a link to its page.",
            json!({ "comboId": { "type": "string", "description": "From card_combos or held_combos." } }),
            &["comboId"],
            &read,
        ),
        tool(
            "held_combos",
            "Combos a deck or the collection holds",
            "Combos (Commander Spellbook's list, Commander-legal combos only) a deck holds whole \
             and, by default, the ones it is one card short of, with the missing card. A deck is \
             read by its active piles; with no deckId, the user's whole collection. A deck's \
             missing cards are only ones the deck could play (its format, its commanders' colours). \
             limit and offset apply to each of the two lists. Short shape; get_combo has the steps.",
            json!({
                "deckId": { "type": "integer", "description": "From list_decks; omit for the whole collection." },
                "list": list_variant.clone(),
                "oneCardAway": { "type": "boolean", "description": "Also answer combos one card short (default true)." },
                "format": { "type": "string", "description": "Collection only: the missing card must be legal in this format key." },
                "identity": { "type": "string", "description": "Collection only: the missing card must fit this colour identity (WUBRG letters, C for colourless)." },
                "limit": { "type": "integer", "minimum": 1, "maximum": 100, "description": "How many of each list (default 20)." },
                "offset": offset.clone(),
            }),
            &[],
            &read,
        ),
        tool(
            "card_scryfall",
            "A card's Scryfall record",
            "The whole Scryfall card object for up to 20 printings, in Scryfall's own format \
             (keywords, layout, produced_mana, card_faces, all_parts and the rest), for facts the \
             other tools do not carry. Without fields every field is answered except the image \
             and shop links (image_uris, card_faces[].image_uris, purchase_uris, related_uris); \
             fields names the top-level ones to answer instead. prices there are as of the last \
             card sync, not the app's marketplace prices, which get_card answers. An id the \
             database lacks is named in missing.",
            json!({
                "cardIds": {
                    "type": "array", "items": { "type": "string" },
                    "minItems": 1, "maxItems": 20,
                    "description": "Printing ids, from find_cards.",
                },
                "fields": {
                    "type": "array", "items": { "type": "string" },
                    "description": "Top-level Scryfall field names to answer, e.g. [\"keywords\", \"layout\"].",
                },
            }),
            &["cardIds"],
            &read,
        ),
        tool(
            "find_tags",
            "Find oracle tags",
            "Scryfall's community oracle tags (what a card does, such as ramp or card draw) whose \
             name matches words, with their slugs and how many cards hold each. A slug is what \
             find_cards takes in filters.oracleTags. Answers tagData: when the tag list was \
             downloaded.",
            json!({
                "text": { "type": "string", "description": "Words of the tag, e.g. \"ramp\"." },
                "limit": { "type": "integer", "minimum": 1, "maximum": 50, "description": "How many to answer (default 10)." },
            }),
            &["text"],
            &read,
        ),
        tool(
            "similar_cards",
            "Cards like a card",
            "Cards that do what a card does, ranked by the oracle tags they share with it (a tag \
             few cards hold counts for more than a common one). Each row names the cardId of its \
             newest printing, its type, cost, score and the shared tags that weigh most. Answers \
             tagData: when the tag list was downloaded.",
            json!({
                "cardId": card_id.clone(),
                "format": { "type": "string", "description": "Only cards legal in this format key (one format_rules marks searchable)." },
                "identity": { "type": "string", "description": "Only cards that fit inside this colour identity (WUBRG letters, C for colourless)." },
                "limit": { "type": "integer", "minimum": 1, "maximum": 50, "description": "How many to answer (default 10)." },
            }),
            &["cardId"],
            &read,
        ),
        tool(
            "format_rules",
            "Format rules",
            "The rules of the formats the app knows: deck size, copies allowed, sideboard, \
             singleton, commander, starting life, companion, mana value cap, what restricted \
             means, whether the app checks decks in it (validates) and whether it has legality \
             data, so find_cards and similar_cards accept it as a format (searchable). With \
             format, that one; without, every format the deck picker offers.",
            json!({
                "format": { "type": "string", "description": "One format key, e.g. \"commander\"." },
            }),
            &[],
            &read,
        ),
        tool(
            "read_guide",
            "Read a guide",
            concat!(
                "How to do a kind of task with these tools: the text of this server's prompt of ",
                "that name, for when the user has not picked it. search_cards: finding cards by ",
                "name and by filters in the database, the collection and the wishlist, and ",
                "showing a search in the app; ",
                "create_widget: building a custom home-page widget; graphql_discovery: the read ",
                "graph, for anything else in the user's data; card_interactions: what a card does, ",
                "its combos, oracle tags, related and similar cards, its Scryfall record and format ",
                "rules; scryfall_syntax: writing a Scryfall search for syntax, and every keyword. ",
                "Read the one that fits before a task of its kind."
            ),
            json!({
                "topic": { "type": "string", "enum": super::prompts::names(), "description": "Which guide." },
            }),
            &["topic"],
            &read,
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
             over them. The query is asked as the page asks it: every variable it declares is \
             filled from the setting of the same name (answered as variables). Use it to check \
             the spec's $state, $item and repeat paths before storing. The graph's own errors and \
             the spec's problems, if any, are answered beside it.",
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
             button). A setting can change what the query asks: declare a variable named after \
             it ($archived for settings.archived) and seed the setting in the spec's \
             state.settings — the app fills it and asks again when the reader changes it. A query \
             or spec that does not fit is refused with every problem named. Answers the stored \
             widget.",
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

/// `find_cards`' thirteen filter fields as JSON Schema properties — `show_search` adds three to them,
/// and building both from this keeps the two schemas from drifting.
fn filter_properties() -> Value {
    json!({
        "format": { "type": "string", "description": "A format key with legality data (see format_rules): only cards playable in it." },
        "colors": { "type": "array", "items": { "type": "string" }, "description": "Colour letters W, U, B, R, G, or just C for colourless: cards whose colour identity fits inside them." },
        "colorsExact": { "type": "boolean", "description": "With colors: exactly those colours, not a subset." },
        "types": { "type": "array", "items": { "type": "string" }, "description": "Card types: Artifact, Battle, Creature, Enchantment, Instant, Land, Planeswalker, Sorcery. Any one of them." },
        "rarities": { "type": "array", "items": { "type": "string" }, "description": "common, uncommon, rare, mythic, special or bonus. Any one of them." },
        "sets": { "type": "array", "items": { "type": "string" }, "description": "Set codes. Any one of them." },
        "manaValues": { "type": "array", "items": { "type": "integer", "minimum": 0, "maximum": 8 }, "description": "Mana values; 8 means 8 or more." },
        "manaX": { "type": "boolean", "description": "Also cards with {X} in their cost." },
        "owned": { "type": "boolean", "description": "true: only cards the user owns; false: only cards they do not." },
        "priceMin": { "type": "number", "minimum": 0, "description": "In the user's marketplace currency." },
        "priceMax": { "type": "number", "minimum": 0, "description": "In the user's marketplace currency." },
        "oracleTags": { "type": "array", "items": { "type": "string" }, "description": "Oracle tag slugs (from find_tags); a card must hold all of them." },
        "gameChanger": { "type": "boolean", "description": "true: only Commander game changers." },
    })
}

/// [`filter_properties`] and the three more `show_search` takes (the page's border, finish and
/// universe chips).
fn show_filter_properties() -> Value {
    let mut properties = filter_properties();
    properties["borders"] = json!({ "type": "array", "items": { "type": "string" }, "description": "regular, borderless or fullart. Any one of them." });
    properties["finishes"] = json!({ "type": "array", "items": { "type": "string" }, "description": "nonfoil, foil or etched. Any one of them." });
    properties["universe"] = json!({ "type": "string", "description": "beyond (Universes Beyond only) or within (Magic's own universe only)." });
    properties
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
        "show_search" => show_search(state, &args).await,
        "get_card" => get_card(state, &args).await,
        "search_collection" => search_collection(state, &args).await,
        "search_wishlist" => search_wishlist(state, &args).await,
        "list_folders" => list_folders(state, &args).await,
        "list_decks" => list_decks(state, &args).await,
        "get_deck" => get_deck(state, &args).await,
        "card_combos" => card_combos(state, &args).await,
        "get_combo" => get_combo(state, &args).await,
        "held_combos" => held_combos(state, &args).await,
        "card_scryfall" => card_scryfall(state, &args).await,
        "find_tags" => find_tags(state, &args).await,
        "similar_cards" => similar_cards(state, &args).await,
        "format_rules" => format_rules(state, &args).await,
        "read_guide" => read_guide(&args),
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
pub(super) struct Args(pub(super) Map<String, Value>);

impl Args {
    /// A string, trimmed; blank is absent.
    pub(super) fn text(&self, name: &str) -> Result<Option<String>, String> {
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

    /// A list of strings, trimmed, blanks dropped; absent is empty.
    pub(super) fn texts(&self, name: &str) -> Result<Vec<String>, String> {
        match self.0.get(name) {
            None | Some(Value::Null) => Ok(Vec::new()),
            Some(Value::Array(items)) => {
                let mut out = Vec::new();
                for item in items {
                    let Some(text) = item.as_str() else {
                        return Err(format!("{name} must be a list of strings."));
                    };
                    let text = text.trim();
                    if !text.is_empty() {
                        out.push(text.to_owned());
                    }
                }
                Ok(out)
            }
            Some(_) => Err(format!("{name} must be a list of strings.")),
        }
    }

    /// A number of zero or more; absent is `None`.
    pub(super) fn amount(&self, name: &str) -> Result<Option<f64>, String> {
        match self.0.get(name) {
            None | Some(Value::Null) => Ok(None),
            Some(v) => v
                .as_f64()
                .filter(|n| n.is_finite() && *n >= 0.0)
                .map(Some)
                .ok_or_else(|| format!("{name} must be a number, zero or more.")),
        }
    }

    /// True or false; absent is `None`, unlike [`Args::flag`], which reads absent as false.
    pub(super) fn switch(&self, name: &str) -> Result<Option<bool>, String> {
        match self.0.get(name) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::Bool(b)) => Ok(Some(*b)),
            Some(_) => Err(format!("{name} must be true or false.")),
        }
    }

    pub(super) fn flag(&self, name: &str) -> Result<bool, String> {
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
pub(super) async fn run(
    state: &Arc<AppState>,
    command: &str,
    args: Value,
) -> Result<Value, String> {
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

/// A JSON array's items, empty for anything else.
fn rows_of(value: &Value) -> Vec<Value> {
    value.as_array().cloned().unwrap_or_default()
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

/// `show_search`'s refusal of a call that narrows nothing — no text, no filter, or filters that are
/// all empty (`{"colors": []}`): shown, it would put the reader's page down for every card.
const SHOW_SEARCH_NEEDS: &str = concat!(
    "show_search needs text (the Search box's words, in Scryfall syntax) ",
    "or at least one field in filters."
);

/// `show_search`: the search checked as `find_cards` checks it, then handed to the app's window.
/// Every refusal comes before any window changes.
async fn show_search(state: &Arc<AppState>, args: &Args) -> Result<Value, String> {
    let text = args.text("text")?;
    if text
        .as_deref()
        .is_some_and(|t| t.chars().count() > super::show::MAX_TEXT_CHARS)
    {
        return Err(format!(
            "text is longer than {} characters.",
            super::show::MAX_TEXT_CHARS
        ));
    }
    let filters = match args.0.get("filters") {
        None | Some(Value::Null) => None,
        Some(Value::Object(map)) if !map.is_empty() => Some(Args(map.clone())),
        Some(Value::Object(_)) => None,
        Some(_) => return Err("filters must be an object.".to_owned()),
    };
    if text.is_none() && filters.is_none() {
        return Err(SHOW_SEARCH_NEEDS.to_owned());
    }
    let sort = match args.0.get("sort") {
        None | Some(Value::Null) => None,
        Some(Value::Object(map)) => {
            let sort = Args(map.clone());
            let key = sort
                .text("key")?
                .ok_or_else(|| "sort.key is required.".to_owned())?;
            if !super::show::SORT_KEYS.contains(&key.as_str()) {
                return Err(format!(
                    "sort.key cannot be {key:?}; use one of: {}.",
                    super::show::SORT_KEYS.join(", ")
                ));
            }
            let dir = if sort.flag("descending")? {
                "desc"
            } else {
                "asc"
            };
            Some(super::show::HandoffSort {
                key,
                dir: dir.to_owned(),
            })
        }
        Some(_) => return Err("sort must be an object.".to_owned()),
    };
    let all_printings = args.switch("allPrintings")?;
    let checked = match &filters {
        Some(filters) => {
            super::filters::checked(state, filters, &super::filters::SHOW_FIELDS).await?
        }
        None => super::filters::CheckedFilters::default(),
    };
    let handoff = super::show::handoff(text.as_deref(), &checked, sort, all_printings);
    if !handoff.narrows() {
        return Err(SHOW_SEARCH_NEEDS.to_owned());
    }
    state.show_search.show(handoff).await
}

async fn find_cards(state: &Arc<AppState>, args: &Args) -> Result<Value, String> {
    let query = args.text("query")?;
    let filters = match args.0.get("filters") {
        None | Some(Value::Null) => None,
        Some(Value::Object(map)) if !map.is_empty() => Some(Args(map.clone())),
        Some(Value::Object(_)) => None,
        Some(_) => return Err("filters must be an object.".to_owned()),
    };
    let syntax = args.text("syntax")?;
    if query.is_none() && filters.is_none() && syntax.is_none() {
        return Err(concat!(
            "find_cards needs a query (words of the card's name), a syntax (a Scryfall search) ",
            "or at least one field in filters."
        )
        .to_owned());
    }
    let set = args.text("set")?.map(|s| s.to_lowercase());
    let limit = args.bounded("limit", 10, 1, 50)?;
    let all = args.flag("allPrintings")?;
    let mut req = match &filters {
        Some(filters) => {
            let checked =
                super::filters::checked(state, filters, &super::filters::FIND_FIELDS).await?;
            super::filters::search_request(&checked)
        }
        None => Map::new(),
    };
    req.insert("text".into(), json!(query));
    if let Some(syntax) = &syntax {
        super::syntax::apply(state, syntax, &mut req).await?;
    }
    req.insert("setCode".into(), json!(set));
    req.insert("collapse".into(), json!(!all));
    req.insert("paperOnly".into(), json!(true));
    req.insert("limit".into(), json!(limit));
    // Prices, and the price filters, are the reader's marketplace's; a read that fails leaves the
    // search on its default.
    if let Ok(market) = run(state, "get_marketplace", json!({})).await {
        if market.is_string() {
            req.insert("marketplace".into(), market);
        }
    }
    let found = run(state, "search_cards", json!({ "req": req })).await?;
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

/// The most `related` entries `get_card` answers; `relatedTotal` names the full count past it.
const RELATED_CAP: usize = 25;

async fn get_card(state: &Arc<AppState>, args: &Args) -> Result<Value, String> {
    let card_id = args.required_text("cardId")?;
    // Prices are the reader's marketplace's, as `find_cards`' are; a read that fails leaves the
    // card on the default.
    let marketplace = run(state, "get_marketplace", json!({}))
        .await
        .ok()
        .filter(Value::is_string);
    let detail = run(
        state,
        "card_detail",
        json!({ "id": card_id, "marketplace": marketplace }),
    )
    .await?;
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
    // Each extra is left out when its read fails, as `owned` is.
    let faces: Vec<Value> = rows(&detail, "faces")
        .iter()
        .map(|f| {
            pick(
                f,
                &[
                    ("name", "name"),
                    ("typeLine", "typeLine"),
                    ("manaCost", "manaCost"),
                    ("oracleText", "oracleText"),
                ],
            )
        })
        .collect();
    if !faces.is_empty() {
        card["faces"] = json!(faces);
    }
    if let Ok(tags) = run(state, "card_oracle_tags", json!({ "cardId": card_id })).await {
        card["tags"] = tags;
        if let Ok(status) = run(state, "oracle_tags_status", json!({})).await {
            with_tag_data(&mut card, &status);
        }
    }
    if let Ok(Value::Array(mut related)) =
        run(state, "card_related", json!({ "id": card_id })).await
    {
        // A token printing can name hundreds of cards; an answer stays short and says how many.
        let total = related.len();
        if total > RELATED_CAP {
            related.truncate(RELATED_CAP);
            card["relatedTotal"] = json!(total);
        }
        card["related"] = json!(related);
    }
    if let Some(oracle) = detail.get("oracleId").and_then(Value::as_str) {
        let page = run(
            state,
            "combos_for_card",
            json!({
                "oracleId": oracle, "search": null, "produces": null, "cardCount": null,
                "ownedOnly": false, "limit": 1, "offset": 0,
            }),
        )
        .await;
        if let Some(total) = page.ok().and_then(|p| p.get("total").cloned()) {
            card["comboCount"] = total;
            if let Ok(status) = run(state, "combos_status", json!({})).await {
                with_combo_data(&mut card, &status, Vec::new());
            }
        }
    }
    Ok(card)
}

/// The top-level Scryfall fields `card_scryfall` leaves out unless asked for by name.
const SCRYFALL_LINKS: [&str; 3] = ["image_uris", "purchase_uris", "related_uris"];

async fn card_scryfall(state: &Arc<AppState>, args: &Args) -> Result<Value, String> {
    let ids = args.texts("cardIds")?;
    if !(1..=20).contains(&ids.len()) {
        return Err("cardIds must hold from 1 to 20 printing ids.".to_owned());
    }
    let fields = args.texts("fields")?;
    let records = run(state, "card_raw", json!({ "ids": ids })).await?;
    let mut cards = Vec::new();
    let mut missing = Vec::new();
    for record in records.as_array().into_iter().flatten() {
        let id = record.get("id").cloned().unwrap_or(Value::Null);
        let Some(Value::Object(scryfall)) = record.get("scryfall") else {
            missing.push(id);
            continue;
        };
        let mut kept = Map::new();
        if fields.is_empty() {
            for (key, value) in scryfall {
                if !SCRYFALL_LINKS.contains(&key.as_str()) {
                    kept.insert(key.clone(), value.clone());
                }
            }
            if let Some(Value::Array(faces)) = kept.get_mut("card_faces") {
                for face in faces {
                    if let Some(face) = face.as_object_mut() {
                        face.remove("image_uris");
                    }
                }
            }
        } else {
            for field in &fields {
                if let Some(value) = scryfall.get(field) {
                    kept.insert(field.clone(), value.clone());
                }
            }
        }
        cards.push(json!({ "cardId": id, "scryfall": kept }));
    }
    Ok(json!({ "cards": cards, "missing": missing }))
}

async fn find_tags(state: &Arc<AppState>, args: &Args) -> Result<Value, String> {
    let text = args.required_text("text")?;
    let limit = args.bounded("limit", 10, 1, 50)?;
    let hits = run(
        state,
        "tag_search",
        json!({ "text": text, "namespace": "oracle", "limit": limit }),
    )
    .await?;
    let tags: Vec<Value> = hits
        .as_array()
        .into_iter()
        .flatten()
        .map(|t| {
            pick(
                t,
                &[
                    ("slug", "slug"),
                    ("label", "label"),
                    ("cardCount", "cardCount"),
                ],
            )
        })
        .collect();
    let status = run(state, "oracle_tags_status", json!({})).await?;
    let mut answer = json!({ "tags": tags });
    with_tag_data(&mut answer, &status);
    Ok(answer)
}

/// The searchable format key `args` names, lower-cased; `None` when it names none. A key with no
/// legality data (`casual`, `limited`, `unspecified`) would silently match nothing, so it is
/// refused with the keys that do work. `specs` is `format_specs_list`'s answer.
pub(super) fn format_key(
    typed: Option<String>,
    field: &str,
    specs: &Value,
) -> Result<Option<String>, String> {
    let Some(key) = typed else {
        return Ok(None);
    };
    let key = key.to_lowercase();
    let searchable: Vec<&str> = specs
        .as_array()
        .into_iter()
        .flatten()
        .filter(|f| f["hasLegalityData"] == true)
        .filter_map(|f| f["key"].as_str())
        .collect();
    if searchable.contains(&key.as_str()) {
        Ok(Some(key))
    } else {
        Err(format!(
            "{field} cannot be {key:?}; the searchable formats are: {}.",
            searchable.join(", ")
        ))
    }
}

async fn similar_cards(state: &Arc<AppState>, args: &Args) -> Result<Value, String> {
    let card_id = args.required_text("cardId")?;
    let limit = args.bounded("limit", 10, 1, 50)?;
    let identity = args.text("identity")?.map(|i| i.to_uppercase());
    let format = if let Some(typed) = args.text("format")? {
        let specs = run(state, "format_specs_list", json!({})).await?;
        format_key(Some(typed), "format", &specs)?
    } else {
        None
    };
    let detail = run(state, "card_detail", json!({ "id": card_id })).await?;
    let Some(oracle) = detail.get("oracleId").and_then(Value::as_str) else {
        return Err(format!(
            "No card has the id {card_id}. Use find_cards to look one up."
        ));
    };
    let found = run(
        state,
        "cards_similar",
        json!({ "oracleId": oracle, "format": format, "identity": identity, "limit": limit }),
    )
    .await?;
    let cards: Vec<Value> = found
        .as_array()
        .into_iter()
        .flatten()
        .map(|c| {
            pick(
                c,
                &[
                    ("name", "name"),
                    ("cardId", "cardId"),
                    ("typeLine", "typeLine"),
                    ("manaCost", "manaCost"),
                    ("score", "score"),
                    ("sharedTags", "sharedTags"),
                ],
            )
        })
        .collect();
    let status = run(state, "oracle_tags_status", json!({})).await?;
    let mut answer = json!({ "cards": cards });
    with_tag_data(&mut answer, &status);
    Ok(answer)
}

async fn format_rules(state: &Arc<AppState>, args: &Args) -> Result<Value, String> {
    let specs = run(state, "format_specs_list", json!({})).await?;
    let wanted = args.text("format")?.map(|k| k.to_lowercase());
    let known: Vec<&str> = specs
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|f| f["key"].as_str())
        .collect();
    if let Some(key) = &wanted {
        if !known.contains(&key.as_str()) {
            return Err(format!(
                "format cannot be {key:?}; the formats are: {}.",
                known.join(", ")
            ));
        }
    }
    let formats: Vec<Value> = rows_of(&specs)
        .iter()
        .filter(|f| match &wanted {
            Some(key) => f["key"] == key.as_str(),
            None => f["enabledInPicker"] == true,
        })
        .map(|f| {
            let mut row = pick(
                f,
                &[
                    ("key", "key"),
                    ("name", "displayName"),
                    ("deckMin", "deckMin"),
                    ("deckMax", "deckMax"),
                    ("maxCopies", "maxCopies"),
                    ("sideboardMax", "sideboardMax"),
                    ("singleton", "singleton"),
                    ("requiresCommander", "requiresCommander"),
                    ("commanderRule", "commanderRule"),
                    ("life", "life"),
                    ("allowsCompanion", "allowsCompanion"),
                    ("maxManaValue", "maxManaValue"),
                    ("restrictedMeaning", "restrictedSemantic"),
                    ("validates", "validates"),
                ],
            );
            row["searchable"] = f["hasLegalityData"].clone();
            row
        })
        .collect();
    Ok(json!({ "formats": formats }))
}

/// `read_guide`: a prompt's text as `prompts/get` answers it with no argument, for a client that
/// runs a prompt only when the user picks it (spec §2).
fn read_guide(args: &Args) -> Result<Value, String> {
    let topics = super::prompts::names();
    let topic = args
        .choice("topic", &topics, None)?
        .ok_or_else(|| "topic is required.".to_owned())?;
    let prompt = super::prompts::get(&topic, None)
        .ok_or_else(|| format!("There is no guide named {topic}."))?;
    Ok(json!({ "topic": topic, "guide": prompt["messages"][0]["content"]["text"] }))
}

async fn search_collection(state: &Arc<AppState>, args: &Args) -> Result<Value, String> {
    let mut query = json!({
        "text": args.text("query")?,
        "folderId": args.int("folderId")?,
        "limit": args.bounded("limit", 50, 1, MAX_LIMIT)?,
        "offset": args.bounded("offset", 0, 0, i64::from(u32::MAX))?,
    });
    if let (Some(syntax), Some(query)) = (args.text("syntax")?, query.as_object_mut()) {
        super::syntax::apply(state, &syntax, query).await?;
    }
    let page = run(state, "collection_list", json!({ "query": query })).await?;
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
    // `folderId: null` is the wishlist's root there, so a search across every folder says
    // `flatten` — `WishlistQuery`'s own convention, the opposite of the collection's.
    let mut query = json!({
        "text": args.text("query")?,
        "folderId": folder,
        "flatten": folder.is_none(),
        "limit": args.bounded("limit", 50, 1, MAX_LIMIT)?,
        "offset": args.bounded("offset", 0, 0, i64::from(u32::MAX))?,
    });
    if let (Some(syntax), Some(query)) = (args.text("syntax")?, query.as_object_mut()) {
        super::syntax::apply(state, &syntax, query).await?;
    }
    let page = run(state, "wishlist_list", json!({ "query": query })).await?;
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

/// The word for a Commander Spellbook bracket letter; an unknown letter is passed through.
fn bracket_word(letter: &str) -> String {
    match letter {
        "R" => "Ruthless",
        "S" => "Spicy",
        "P" => "Powerful",
        "O" => "Oddball",
        "C" => "Core",
        "E" => "Exhibition",
        "B" => "Banned",
        other => other,
    }
    .to_owned()
}

/// A newline-joined column as a list, empty lines dropped.
fn lines(value: &Value, field: &str) -> Vec<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .split('\n')
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_owned)
        .collect()
}

/// `comboData`: when the combo list was last downloaded (Unix seconds, null if never).
fn combo_data(status: &Value) -> Value {
    json!({ "downloadedAt": status.get("fetchedAt").cloned().unwrap_or(Value::Null) })
}

/// Put `comboData` on an answer, with the sentence that says so when nothing was downloaded.
fn with_combo_data(answer: &mut Value, status: &Value, notes: Vec<String>) {
    with_feed_data(
        answer,
        "comboData",
        combo_data(status),
        "combo list",
        "no combos",
        notes,
    );
}

/// `tagData`: when the oracle tag list was last downloaded (Unix seconds, null if never).
fn tag_data(status: &Value) -> Value {
    json!({ "downloadedAt": status.get("ingestedAt").cloned().unwrap_or(Value::Null) })
}

/// Put `tagData` on an answer, as [`with_combo_data`] puts `comboData`.
fn with_tag_data(answer: &mut Value, status: &Value) {
    with_feed_data(
        answer,
        "tagData",
        tag_data(status),
        "oracle tag list",
        "no tags",
        Vec::new(),
    );
}

/// Put a downloaded feed's `{ downloadedAt }` on an answer under `key`. When nothing was ever
/// downloaded the answer also carries `note`, one sentence saying the `list` is missing, so an
/// empty answer does not read as `nothing`, and where to fetch it; `notes` are joined after it.
fn with_feed_data(
    answer: &mut Value,
    key: &str,
    data: Value,
    list: &str,
    nothing: &str,
    mut notes: Vec<String>,
) {
    if data["downloadedAt"].is_null() {
        notes.insert(
            0,
            format!(
                concat!(
                    "The {list} has not been downloaded yet, so an empty answer does not mean ",
                    "there are {nothing}. The app fetches it weekly when it starts, and ",
                    "Settings can fetch it now."
                ),
                list = list,
                nothing = nothing
            ),
        );
    }
    answer[key] = data;
    // A note an earlier feed put on this answer stays, ahead of this feed's.
    if let Some(earlier) = answer.get("note").and_then(Value::as_str) {
        notes.insert(0, earlier.to_owned());
    }
    if !notes.is_empty() {
        answer["note"] = json!(notes.join(" "));
    }
}

/// The short shape of a `CardCombo`, `DeckCombo` or `HeldCombo`.
fn short_combo(v: &Value) -> Value {
    let cards: Vec<Value> = match v.get("cards").and_then(Value::as_array) {
        Some(names) => names.clone(),
        None => rows(v, "pieces")
            .iter()
            .filter_map(|p| p.get("name").cloned())
            .collect(),
    };
    let letter = v
        .get("bracketTag")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut out = json!({
        "comboId": v.get("id"),
        "cards": cards,
        "produces": lines(v, "produces"),
        "bracketTag": bracket_word(letter),
        "templatesNeeded": v.get("templateCount"),
        "popularity": v.get("popularity"),
    });
    if let Some(m) = v.get("missing").filter(|m| !m.is_null()) {
        out["missing"] = pick(
            m,
            &[("name", "name"), ("cardId", "cardId"), ("owned", "owned")],
        );
    }
    out
}

/// The full shape of a `CardCombo`.
fn full_combo(v: &Value) -> Value {
    let mut out = short_combo(v);
    out["identity"] = v.get("identity").cloned().unwrap_or(Value::Null);
    out["pieces"] = Value::Array(
        rows(v, "pieces")
            .iter()
            .map(|p| {
                pick(
                    p,
                    &[
                        ("name", "name"),
                        ("cardId", "cardId"),
                        ("quantity", "quantity"),
                        ("mustBeCommander", "mustBeCommander"),
                        ("owned", "owned"),
                    ],
                )
            })
            .collect(),
    );
    out["requires"] = json!(lines(v, "requires"));
    out["steps"] = json!(lines(v, "description"));
    out["prerequisites"] = json!({
        "easy": lines(v, "easyPrerequisites"),
        "notable": lines(v, "notablePrerequisites"),
    });
    out["manaNeeded"] = v.get("manaNeeded").cloned().unwrap_or(Value::Null);
    out["url"] = json!(format!(
        "https://commanderspellbook.com/combo/{}/",
        v.get("id").and_then(Value::as_str).unwrap_or_default()
    ));
    out
}

fn short_list(list: &[Value]) -> Vec<Value> {
    list.iter().map(short_combo).collect()
}

async fn card_combos(state: &Arc<AppState>, args: &Args) -> Result<Value, String> {
    let card_id = args.required_text("cardId")?;
    let limit = args.bounded("limit", 10, 1, 50)?;
    let offset = args.bounded("offset", 0, 0, i64::from(u32::MAX))?;
    let detail = run(state, "card_detail", json!({ "id": card_id })).await?;
    let Some(oracle) = detail.get("oracleId").and_then(Value::as_str) else {
        return Err(format!(
            "No card has the id {card_id}. Use find_cards to look one up."
        ));
    };
    let page = run(
        state,
        "combos_for_card",
        json!({
            "oracleId": oracle,
            "search": args.text("search")?,
            "produces": args.text("produces")?,
            "cardCount": args.int("cardCount")?,
            "ownedOnly": args.flag("ownedOnly")?,
            "limit": limit,
            "offset": offset,
        }),
    )
    .await?;
    let status = run(state, "combos_status", json!({})).await?;
    let mut answer = json!({
        "total": page.get("total"),
        "matching": page.get("matching"),
        "ownedTotal": page.get("ownedTotal"),
        "sizes": page.get("byCardCount"),
        "combos": short_list(&rows(&page, "combos")),
    });
    with_combo_data(&mut answer, &status, Vec::new());
    Ok(answer)
}

async fn get_combo(state: &Arc<AppState>, args: &Args) -> Result<Value, String> {
    let id = args.required_text("comboId")?;
    let combo = run(state, "combo_get", json!({ "id": id })).await?;
    let status = run(state, "combos_status", json!({})).await?;
    if combo.is_null() {
        let mut why =
            format!("No combo has the id {id}. Use card_combos or held_combos to find one.");
        // Read through the feed helper, so the missing-list sentence is the one every answer uses.
        let mut missing = json!({});
        with_combo_data(&mut missing, &status, Vec::new());
        if let Some(note) = missing.get("note").and_then(Value::as_str) {
            why.push(' ');
            why.push_str(note);
        }
        return Err(why);
    }
    let mut answer = full_combo(&combo);
    with_combo_data(&mut answer, &status, Vec::new());
    Ok(answer)
}

/// A deck's combos: every complete one (sliced to the page) and, when asked, the ones one card
/// away, filtered by what the deck could play.
async fn deck_combos(
    state: &Arc<AppState>,
    deck_id: i64,
    variant: &str,
    near: bool,
    (limit, offset): (i64, i64),
    notes: &mut Vec<String>,
) -> Result<(Vec<Value>, Value, Option<Value>), String> {
    let detail = run(
        state,
        "deck_get",
        json!({ "id": deck_id, "variant": variant }),
    )
    .await?;
    if detail.is_null() {
        return Err(format!(
            "No deck has the id {deck_id}. Use list_decks to look one up."
        ));
    }
    // The deck's cards are the printings of its active piles, once each.
    let mut card_ids: Vec<String> = Vec::new();
    for card in rows(&detail, "cards") {
        if card.get("categoryActive").and_then(Value::as_bool) != Some(true) {
            continue;
        }
        if let Some(id) = card.get("cardId").and_then(Value::as_str) {
            if !card_ids.iter().any(|c| c == id) {
                card_ids.push(id.to_owned());
            }
        }
    }
    let format_key = detail["deck"]["formatKey"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    if format_key != "commander" {
        notes.push(
            "The combo list covers Commander-legal combos only, so none found here does not \
             mean none exist in this deck's format."
                .to_owned(),
        );
    }
    let all = run(state, "combos_for_cards", json!({ "cardIds": card_ids })).await?;
    let all = all.as_array().cloned().unwrap_or_default();
    let total = json!(all.len());
    let complete: Vec<Value> = all
        .into_iter()
        .skip(offset as usize)
        .take(limit as usize)
        .collect();
    if !near {
        return Ok((complete, total, None));
    }
    let specs = run(state, "format_specs_list", json!({})).await?;
    let has_data = specs.as_array().into_iter().flatten().any(|s| {
        s.get("key").and_then(Value::as_str) == Some(format_key.as_str())
            && s.get("hasLegalityData").and_then(Value::as_bool) == Some(true)
    });
    let identities = run(state, "deck_commander_identities", json!({})).await?;
    let field = if variant == "theory" {
        "theoryIdentity"
    } else {
        "identity"
    };
    // `""` is a colourless commander, which `combos_near` reads as `"C"` (an empty identity
    // there is no filter); null is no commander, so no filter.
    let identity = identities
        .as_array()
        .into_iter()
        .flatten()
        .find(|i| i.get("deckId").and_then(Value::as_i64) == Some(deck_id))
        .and_then(|i| i.get(field))
        .and_then(Value::as_str)
        .map(|s| if s.is_empty() { "C" } else { s }.to_owned());
    let away = run(
        state,
        "combos_near",
        json!({
            "cardIds": card_ids,
            "format": has_data.then_some(format_key),
            "identity": identity,
            "limit": limit,
            "offset": offset,
        }),
    )
    .await?;
    Ok((complete, total, Some(away)))
}

async fn held_combos(state: &Arc<AppState>, args: &Args) -> Result<Value, String> {
    let limit = args.bounded("limit", 20, 1, 100)?;
    let offset = args.bounded("offset", 0, 0, i64::from(u32::MAX))?;
    let near = match args.0.get("oneCardAway") {
        None | Some(Value::Null) => true,
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err("oneCardAway must be true or false.".to_owned()),
    };
    let variant = args
        .choice("list", &["live", "theory"], Some("live"))?
        .unwrap_or_default();
    let mut format = args.text("format")?;
    let mut identity = args.text("identity")?;
    // A deck brings its own format and commanders; only the collection's are checked here.
    if args.int("deckId")?.is_none() {
        if let Some(typed) = format.take() {
            let specs = run(state, "format_specs_list", json!({})).await?;
            format = format_key(Some(typed), "format", &specs)?;
        }
        identity = identity.map(|i| i.to_uppercase());
    }
    let mut notes = Vec::new();
    let (complete, complete_total, away) = match args.int("deckId")? {
        None => {
            let held = |near: bool| {
                run(
                    state,
                    "combos_in_collection",
                    json!({ "near": near, "format": format, "identity": identity,
                            "limit": limit, "offset": offset }),
                )
            };
            let complete = held(false).await?;
            let away = if near { Some(held(true).await?) } else { None };
            (
                rows(&complete, "combos"),
                complete.get("total").cloned().unwrap_or(json!(0)),
                away,
            )
        }
        Some(deck_id) => {
            if format.is_some() || identity.is_some() {
                return Err(
                    "format and identity are for the whole collection; a deck's own \
                            format and commanders are used."
                        .to_owned(),
                );
            }
            deck_combos(state, deck_id, &variant, near, (limit, offset), &mut notes).await?
        }
    };
    let status = run(state, "combos_status", json!({})).await?;
    let mut answer = json!({
        "complete": short_list(&complete),
        "completeTotal": complete_total,
    });
    if let Some(away) = away {
        answer["oneCardAway"] = json!(short_list(&rows(&away, "combos")));
        answer["oneCardAwayTotal"] = away.get("total").cloned().unwrap_or(json!(0));
    }
    with_combo_data(&mut answer, &status, notes);
    Ok(answer)
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
    // The pair: a required variable needs a setting to be filled from.
    if let (Some(query), Some(spec)) = (query, spec) {
        problems.extend(variable_problems(query, spec));
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

/// A variable a document declares: its name, its type as written, and whether it has a default.
struct Declared {
    name: String,
    ty: String,
    default: bool,
}

/// **The variables a document declares**, in order, each once — `queryVariables.ts`'
/// `declaredVariables`: a declaration is `$name:` (a use has no colon after it), read with strings,
/// block strings and comments taken out first.
fn declared_variables(query: &str) -> Vec<Declared> {
    // The document with every string and comment blanked, so nothing inside one is read as code.
    let mut code = String::with_capacity(query.len());
    let mut chars = query.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '#' => {
                while chars.peek().is_some_and(|&n| n != '\n') {
                    chars.next();
                }
                code.push(' ');
            }
            '"' => {
                let mut look = chars.clone();
                if look.next() == Some('"') && look.next() == Some('"') {
                    // A block string, to its closing three quotes.
                    chars.next();
                    chars.next();
                    let mut quotes = 0;
                    for n in chars.by_ref() {
                        quotes = if n == '"' { quotes + 1 } else { 0 };
                        if quotes == 3 {
                            break;
                        }
                    }
                } else {
                    while let Some(n) = chars.next() {
                        match n {
                            '\\' => {
                                chars.next();
                            }
                            '"' | '\n' => break,
                            _ => {}
                        }
                    }
                }
                code.push(' ');
            }
            c => code.push(c),
        }
    }

    let is_start = |c: char| c == '_' || c.is_ascii_alphabetic();
    let is_part = |c: char| c == '_' || c.is_ascii_alphanumeric();
    let mut declared: Vec<Declared> = Vec::new();
    let mut at = 0;
    while let Some(dollar) = code[at..].find('$') {
        let start = at + dollar + 1;
        at = start;
        let name: String = code[start..].chars().take_while(|&c| is_part(c)).collect();
        if !name.chars().next().is_some_and(is_start) {
            continue;
        }
        let after = code[start + name.len()..].trim_start();
        let Some(ty) = after.strip_prefix(':') else {
            continue;
        };
        let ty_end = ty.find(['=', ',', ')', '$']).unwrap_or(ty.len());
        let default = ty[ty_end..].starts_with('=');
        if !declared.iter().any(|d| d.name == name) {
            declared.push(Declared {
                name,
                ty: ty[..ty_end].trim().to_owned(),
                default,
            });
        }
    }
    declared
}

/// **A widget's query variables, from its settings** — `queryVariables.ts`' `queryVariables`: each
/// declared variable the settings hold, by name, and `None` for a document that declares none. Both
/// sides hold to `generated/__golden__/query-variables.json`.
fn query_variables(query: &str, settings: &Map<String, Value>) -> Option<Map<String, Value>> {
    let declared = declared_variables(query);
    if declared.is_empty() {
        return None;
    }
    Some(
        declared
            .into_iter()
            .filter_map(|d| settings.get(&d.name).map(|v| (d.name, v.clone())))
            .collect(),
    )
}

/// The spec's `/settings` seeds, with `saved` laid over them — the settings a widget is asked with.
fn widget_settings(spec: Option<&Value>, saved: Option<&Map<String, Value>>) -> Map<String, Value> {
    let mut settings = spec
        .and_then(|s| s.pointer("/state/settings"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for (key, value) in saved.into_iter().flatten() {
        settings.insert(key.clone(), value.clone());
    }
    settings
}

/// Every required variable (`!`, no default) the spec seeds no setting for — a widget that would be
/// refused by the graph the first time it is drawn.
fn variable_problems(query: &str, spec: &Value) -> Vec<String> {
    let seeded = widget_settings(Some(spec), None);
    declared_variables(query)
        .into_iter()
        .filter(|d| d.ty.ends_with('!') && !d.default && !seeded.contains_key(&d.name))
        .map(|d| {
            format!(
                "The query's ${name} is required ({ty}), and the spec seeds no settings.{name} to \
                 fill it: add it to the spec's state.settings.",
                name = d.name,
                ty = d.ty
            )
        })
        .collect()
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
    let settings = widget_settings(spec, saved);
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
    // Asked as the page asks it: each declared variable from the setting of its name.
    let variables =
        query_variables(&query, &widget_settings(spec.as_ref(), saved.as_ref())).map(Value::Object);
    let core = state.core.clone();
    let asked = variables.clone();
    let response = tauri::async_runtime::spawn_blocking(move || {
        let response = crate::graph::graph().run(&core, &query, asked, None, None);
        serde_json::to_value(response).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("the graph could not be read: {e}"))??;
    let data = response.get("data").cloned().unwrap_or(Value::Null);
    let mut answer = json!({
        "state": widget_state(spec.as_ref(), &data, saved.as_ref()),
    });
    if let Some(variables) = variables {
        answer["variables"] = variables;
    }
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
    let mut problems = widget_problems(query.as_deref(), spec.as_ref());
    // One half given: it is paired with the stored other half, so a new query's required variable
    // is held to the stored spec's settings, and a new spec's settings to the stored query.
    if query.is_some() != spec.is_some() {
        let stored = widget_get(state, args).await?;
        let stored_query = stored["query"].as_str().unwrap_or_default();
        problems.extend(variable_problems(
            query.as_deref().unwrap_or(stored_query),
            spec.as_ref().unwrap_or(&stored["spec"]),
        ));
    }
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
    use crate::mcp::show::{HandoffSort, SearchShownReport};
    use crate::mcp::testing::{state, state_with, FakeWindows};

    fn seed(state: &AppState, f: impl FnOnce(&rusqlite::Connection)) {
        let conn = state.db.lock().unwrap();
        f(&conn);
    }

    async fn done(state: &Arc<AppState>, name: &str, args: Value) -> Value {
        match call(state, name, args).await {
            Called::Done(v) => {
                assert!(v.is_object(), "{name} answered a non-object: {v}");
                v
            }
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

    #[tokio::test]
    async fn show_search_hands_the_window_the_checked_search_and_answers_the_page() {
        let fake = Arc::new(FakeWindows::forward(true));
        let state = state_with("show-search", fake.clone());
        seed(&state, |c| {
            filter_cards(c);
            tag(c, "ramp", "Ramp", &["o-f-drake"]);
            tags_downloaded(c);
        });
        let call = tokio::spawn({
            let state = state.clone();
            async move {
                done(
                    &state,
                    "show_search",
                    json!({
                        "text": "t:creature",
                        "filters": { "format": "commander", "oracleTags": ["ramp"], "gameChanger": true, "borders": ["borderless"] },
                        "sort": { "key": "price", "descending": true },
                    }),
                )
                .await
            }
        });
        let sent = fake.wait_for_one().await;
        assert_eq!(sent.text, "t:creature is:gamechanger");
        assert_eq!(sent.format.as_deref(), Some("commander"));
        assert_eq!(sent.tags[0].label, "Ramp");
        assert_eq!(sent.borders, ["borderless"]);
        assert_eq!(
            sent.sort,
            Some(HandoffSort {
                key: "price".into(),
                dir: "desc".into()
            })
        );
        assert_eq!(sent.all_printings, None);
        state.show_search.report(
            sent.id,
            SearchShownReport {
                total: 2,
                ..Default::default()
            },
        );
        assert_eq!(call.await.unwrap()["total"], 2);
    }

    #[tokio::test]
    async fn show_search_refuses_before_any_window_changes() {
        let fake = Arc::new(FakeWindows::forward(true));
        let state = state_with("show-search-refusals", fake.clone());
        seed(&state, filter_cards);
        let long = "a".repeat(1001);
        for (args, word) in [
            (json!({}), "text"),
            (json!({ "filters": {} }), "text"),
            // Filters that narrow nothing are the empty call, and would wipe the reader's page.
            (json!({ "filters": { "colors": [] } }), "text"),
            (
                json!({ "text": "  ", "filters": { "colorsExact": true, "gameChanger": false }, "sort": { "key": "price" } }),
                "text",
            ),
            (json!({ "text": long }), "1000"),
            (
                json!({ "text": "x", "sort": { "key": "power" } }),
                "sort.key",
            ),
            (
                json!({ "filters": { "rarities": ["epic"] } }),
                "filters.rarities",
            ),
            (
                json!({ "filters": { "oracleTags": ["nonesuch"] } }),
                "find_tags",
            ),
            (
                json!({ "filters": { "universe": "outer" } }),
                "filters.universe",
            ),
        ] {
            let why = refused(&state, "show_search", args.clone()).await;
            assert!(why.contains(word), "{args}: {why}");
            assert!(!why.contains("  "), "{args}: {why}");
        }
        assert!(
            fake.shown.lock().unwrap().is_empty(),
            "a refused call sent nothing"
        );
    }

    #[test]
    fn show_search_asks_first_and_is_not_a_read() {
        let tool = list()
            .into_iter()
            .find(|t| t["name"] == "show_search")
            .unwrap();
        let d = tool["description"].as_str().unwrap();
        assert!(
            d.contains("Ask the user in chat first") && d.contains("only after they say yes"),
            "{d}"
        );
        assert_eq!(tool["annotations"]["readOnlyHint"], false);
        assert_eq!(tool["annotations"]["destructiveHint"], false);
        assert_eq!(tool["annotations"]["idempotentHint"], true);
        assert_eq!(
            tool["inputSchema"]["properties"]["filters"]["additionalProperties"],
            false
        );
    }

    /// The `filters` each schema describes are the fields each tool's check accepts, and
    /// `show_search`'s are `find_cards`' thirteen and then its own three.
    #[test]
    fn the_filters_schemas_describe_the_fields_the_checks_accept() {
        use std::collections::BTreeSet;
        let keys = |name: &str| -> BTreeSet<String> {
            let tools = list();
            let tool = tools.iter().find(|t| t["name"] == name).unwrap();
            tool["inputSchema"]["properties"]["filters"]["properties"]
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect()
        };
        let set = |fields: &[&str]| -> BTreeSet<String> {
            fields.iter().map(|f| (*f).to_owned()).collect()
        };
        assert_eq!(keys("find_cards"), set(&crate::mcp::filters::FIND_FIELDS));
        assert_eq!(keys("show_search"), set(&crate::mcp::filters::SHOW_FIELDS));
        assert_eq!(
            crate::mcp::filters::SHOW_FIELDS[..13],
            crate::mcp::filters::FIND_FIELDS
        );
    }

    #[test]
    fn every_tool_has_a_closed_object_schema_and_a_distinct_name() {
        let tools = list();
        let mut names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names.len(), 27);
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), 27, "names are unique");
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

    /// The custom widget's three writes are the only tools that write at all, and only a widget —
    /// the reader's cards, decks and wishlists take no write from here (the owner's decision,
    /// 2026-10-31). `show_search` is not read-only either, but it changes only what a window shows:
    /// it is neither destructive nor a write of any data.
    #[test]
    fn only_a_widget_s_writes_say_they_write() {
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
                ("show_search", false),
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
        for table in CUSTOM_WIDGET_TABLES {
            assert!(user.contains(table), "{table} is not a user table");
        }
    }

    #[tokio::test]
    async fn the_collection_search_finds_what_the_reader_owns() {
        let state = state("collection-search");
        seed(&state, |c| {
            grimoire_core::schema::fixtures::seed_card(c, "bolt-1", "lea", "161");
            grimoire_core::schema::fixtures::entry(c, "bolt-1", 3);
        });
        let found = done(&state, "search_collection", json!({})).await;
        assert_eq!(found["total"], 1);
        assert_eq!(found["entries"][0]["cardId"], "bolt-1");
        assert_eq!(found["entries"][0]["quantity"], 3);
        assert_eq!(found["entries"][0]["set"], "lea");
    }

    /// The three adds are retired: no tool writes the reader's cards (the owner's decision).
    #[tokio::test]
    async fn the_collection_writes_are_no_tools() {
        let state = state("no-adds");
        for gone in ["add_to_collection", "add_to_wishlist", "add_card_to_deck"] {
            assert!(list().iter().all(|t| t["name"] != gone), "{gone} is listed");
            assert!(matches!(
                call(&state, gone, json!({ "cardId": "bolt-1" })).await,
                Called::NoSuchTool
            ));
        }
    }

    #[test]
    fn a_deck_name_matches_every_word_in_any_order_and_case() {
        assert!(matches_words("Bolt Tribal", Some("tribal bolt")));
        assert!(!matches_words("Bolt Tribal", Some("bolt elves")));
        assert!(matches_words("Bolt Tribal", None));
    }

    /// The three graph tools: the schema an agent writes against, a draft checked with where its
    /// problem is, and the answer a widget would get — over a seeded deck.
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

    /// `queryVariables.ts` and [`query_variables`] hold to one golden, so a preview asks what the
    /// page asks.
    #[test]
    fn the_query_variables_are_the_page_s() {
        let golden: Value = serde_json::from_str(include_str!(
            "../../../../../packages/ui/features/home/generated/__golden__/query-variables.json"
        ))
        .unwrap();
        let cases = golden.as_array().unwrap();
        assert!(cases.len() >= 5, "the golden was read");
        for case in cases {
            let settings = case["settings"].as_object().unwrap();
            let asked = query_variables(case["query"].as_str().unwrap(), settings);
            assert_eq!(
                asked.map(Value::Object).unwrap_or(Value::Null),
                case["variables"],
                "{}",
                case["name"]
            );
        }
    }

    #[test]
    fn a_declaration_has_its_type_and_its_default() {
        let declared =
            declared_variables("query ($deck: Int!, $tags: [String!]! = [], $limit: Int) { x }");
        let got: Vec<(&str, &str, bool)> = declared
            .iter()
            .map(|d| (d.name.as_str(), d.ty.as_str(), d.default))
            .collect();
        assert_eq!(
            got,
            [
                ("deck", "Int!", false),
                ("tags", "[String!]!", true),
                ("limit", "Int", false)
            ]
        );
        assert!(declared_variables("{ x(t: \"\"\"$a: no\"\"\", u: \"$b: no\") }").is_empty());
    }

    #[tokio::test]
    async fn a_required_variable_needs_a_seeded_setting() {
        let state = state("widget-variables");
        let query = "query ($archived: Boolean!) { decks(archived: $archived) { id } }";
        let unseeded = done(
            &state,
            "widget_check",
            json!({ "query": query, "spec": widget_spec() }),
        )
        .await;
        assert_eq!(unseeded["valid"], false);
        assert!(unseeded["problems"][0]
            .as_str()
            .unwrap()
            .contains("$archived is required (Boolean!)"));

        let mut seeded = widget_spec();
        seeded["state"] = json!({ "settings": { "archived": false } });
        let fine = done(
            &state,
            "widget_check",
            json!({ "query": query, "spec": seeded }),
        )
        .await;
        assert_eq!(fine["valid"], true, "{fine}");

        // An update that sends one half is held to the stored other half.
        let made = done(
            &state,
            "widget_create",
            json!({ "name": "Decks", "query": "{ decks { id } }", "spec": widget_spec() }),
        )
        .await;
        let why = refused(
            &state,
            "widget_update",
            json!({ "widgetId": made["id"], "query": query }),
        )
        .await;
        assert!(why.contains("$archived is required"), "{why}");
    }

    #[tokio::test]
    async fn a_preview_asks_with_the_variables_its_settings_fill() {
        let state = state("widget-preview-variables");
        let mut spec = widget_spec();
        spec["state"] = json!({ "settings": { "archived": true, "rows": 3 } });
        let preview = done(
            &state,
            "widget_preview",
            json!({
                "query": "query ($archived: Boolean) { decks(archived: $archived) { id } }",
                "spec": spec,
                "settings": { "archived": false },
            }),
        )
        .await;
        // The setting laid over the seed is the one asked with; a setting no variable names is not.
        assert_eq!(preview["variables"], json!({ "archived": false }));
        assert_eq!(preview["state"]["decks"], json!([]));
        assert!(preview.get("errors").is_none(), "{preview}");
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

    // ---- the guide ----------------------------------------------------------------------

    /// Every prompt is also a guide the agent can read by itself (spec §2): the text `prompts/get`
    /// answers with no argument.
    #[tokio::test]
    async fn read_guide_answers_every_prompt() {
        let state = state("read-guide");
        for topic in super::super::prompts::names() {
            let answer = done(&state, "read_guide", json!({ "topic": topic })).await;
            let prompt = super::super::prompts::get(topic, None).unwrap();
            assert_eq!(answer["topic"], topic);
            assert_eq!(answer["guide"], prompt["messages"][0]["content"]["text"]);
            assert!(answer["guide"]
                .as_str()
                .is_some_and(|guide| guide.starts_with("# ")));
        }
    }

    /// The topic enum is the prompt list, so a prompt added later is a topic at once; the
    /// description says what each topic is for, so it must name every one.
    #[test]
    fn read_guide_s_topics_are_the_prompt_names() {
        let tools = list();
        let guide = tools
            .iter()
            .find(|t| t["name"] == "read_guide")
            .expect("read_guide is listed");
        let listed: Vec<Value> = super::super::prompts::list()
            .iter()
            .map(|p| p["name"].clone())
            .collect();
        assert_eq!(
            guide["inputSchema"]["properties"]["topic"]["enum"],
            json!(listed)
        );
        assert_eq!(guide["inputSchema"]["required"], json!(["topic"]));
        assert_eq!(guide["annotations"]["readOnlyHint"], true);
        let description = guide["description"].as_str().unwrap();
        for topic in super::super::prompts::names() {
            assert!(
                description.contains(topic),
                "read_guide's description does not name {topic}"
            );
        }
    }

    #[tokio::test]
    async fn a_guide_that_is_no_prompt_is_refused() {
        let state = state("read-guide-unknown");
        let why = refused(&state, "read_guide", json!({ "topic": "add_cards" })).await;
        assert!(why.starts_with("topic cannot be \"add_cards\""), "{why}");
        assert!(why.contains("card_interactions"), "{why}");
        assert_eq!(
            refused(&state, "read_guide", json!({})).await,
            "topic is required."
        );
    }

    // ---- the combo tools ----------------------------------------------------------------

    /// A printing named `name` of the oracle card `o-<id>`, with the two columns the one-away
    /// filters read.
    fn combo_card(c: &rusqlite::Connection, id: &str, name: &str, identity: &str, legal: bool) {
        grimoire_core::schema::fixtures::seed_card(c, id, "lea", "1");
        let mask = if legal {
            grimoire_core::legalities::bit("commander").unwrap() as i64
        } else {
            0
        };
        c.execute(
            "UPDATE cards SET name = ?2, color_identity = ?3, legal_mask = ?4 WHERE id = ?1",
            rusqlite::params![id, name, identity, mask],
        )
        .unwrap();
    }

    /// One stored combo naming `pieces` (`(oracle id, name)`), every column spelled out.
    fn combo(c: &rusqlite::Connection, id: &str, bracket: &str, pieces: &[(&str, &str)]) {
        c.execute(
            "INSERT INTO combos (id, bracket_tag, card_count, template_count, identity, produces,
                                 mana_needed, easy_prerequisites, notable_prerequisites,
                                 description, popularity, requires)
             VALUES (?1, ?2, ?3, 1, 'U', 'Infinite mana\nInfinite life', '{U}{U}',
                     'Both on the battlefield.\n', 'Mana from elsewhere.',
                     'Tap A.\nTap B.\n', 7, 'a creature with flying\n')",
            rusqlite::params![id, bracket, pieces.len() as i64],
        )
        .unwrap();
        for (oracle, name) in pieces {
            c.execute(
                "INSERT INTO combo_cards (combo_id, oracle_id, name, quantity, must_be_commander)
                 VALUES (?1, ?2, ?3, 1, 0)",
                rusqlite::params![id, oracle, name],
            )
            .unwrap();
        }
    }

    fn downloaded(c: &rusqlite::Connection) {
        c.execute(
            "INSERT INTO combo_meta (id, checked_at, fetched_at) VALUES (1, 1700000100, 1700000000)",
            [],
        )
        .unwrap();
    }

    const CA: (&str, &str) = ("o-p-a", "Card A");
    const CB: (&str, &str) = ("o-p-b", "Card B");
    const CC: (&str, &str) = ("o-p-c", "Card C");

    #[tokio::test]
    async fn card_combos_lists_a_card_s_combos_short() {
        let state = state("card-combos");
        seed(&state, |c| {
            combo_card(c, "p-a", "Card A", "U", true);
            combo_card(c, "p-b", "Card B", "U", true);
            combo(c, "c1", "R", &[CA, CB]);
            downloaded(c);
        });
        let got = done(&state, "card_combos", json!({ "cardId": "p-a" })).await;
        assert_eq!(got["total"], 1);
        let one = &got["combos"][0];
        assert_eq!(one["comboId"], "c1");
        assert_eq!(one["bracketTag"], "Ruthless");
        assert_eq!(one["cards"], json!(["Card A", "Card B"]));
        assert_eq!(one["produces"], json!(["Infinite mana", "Infinite life"]));
        assert_eq!(one["templatesNeeded"], 1);
        assert_eq!(one["popularity"], 7);
        assert!(one.get("steps").is_none(), "the short shape has no steps");
        assert_eq!(got["comboData"]["downloadedAt"], 1_700_000_000);
        assert!(got.get("note").is_none());
        assert_eq!(got["sizes"][0]["cards"], 2);

        let found = done(
            &state,
            "card_combos",
            json!({ "cardId": "p-a", "produces": "infinite mana" }),
        )
        .await;
        assert_eq!(found["matching"], 1);

        let why = refused(&state, "card_combos", json!({ "cardId": "nope" })).await;
        assert!(why.contains("find_cards"), "{why}");
        let why = refused(
            &state,
            "card_combos",
            json!({ "cardId": "p-a", "limit": 51 }),
        )
        .await;
        assert!(why.contains("limit"), "{why}");
    }

    #[tokio::test]
    async fn get_combo_answers_one_combo_whole() {
        let state = state("get-combo");
        seed(&state, |c| {
            combo_card(c, "p-a", "Card A", "U", true);
            combo(c, "c1", "S", &[CA, CB]);
            downloaded(c);
        });
        let got = done(&state, "get_combo", json!({ "comboId": "c1" })).await;
        assert_eq!(got["bracketTag"], "Spicy");
        assert_eq!(got["steps"], json!(["Tap A.", "Tap B."]));
        assert_eq!(
            got["prerequisites"]["easy"],
            json!(["Both on the battlefield."])
        );
        assert_eq!(
            got["prerequisites"]["notable"],
            json!(["Mana from elsewhere."])
        );
        assert_eq!(got["requires"], json!(["a creature with flying"]));
        assert_eq!(got["manaNeeded"], "{U}{U}");
        assert_eq!(got["identity"], "U");
        assert_eq!(got["url"], "https://commanderspellbook.com/combo/c1/");
        assert_eq!(got["pieces"][0]["name"], "Card A");
        assert_eq!(got["pieces"][0]["cardId"], "p-a");
        assert_eq!(got["comboData"]["downloadedAt"], 1_700_000_000);

        let why = refused(&state, "get_combo", json!({ "comboId": "nope" })).await;
        assert!(why.contains("nope"), "{why}");
    }

    /// A deck (`format`) with `main` in its main pile, `maybe` in a switched-off one, and
    /// `commander` in the command zone when given.
    fn combo_deck(
        c: &rusqlite::Connection,
        format: &str,
        main: &[&str],
        maybe: &[&str],
        commander: Option<&str>,
    ) -> i64 {
        use grimoire_core::schema::fixtures::{category, deck, deck_card};
        let id = deck(c, "Combo deck");
        c.execute(
            "UPDATE decks SET format_key = ?2 WHERE id = ?1",
            rusqlite::params![id, format],
        )
        .unwrap();
        let pile = category(c, id, "main", "Main");
        for card in main {
            deck_card(c, id, card, pile, 1);
        }
        let pile = category(c, id, "maybe", "Maybe");
        for card in maybe {
            deck_card(c, id, card, pile, 1);
        }
        if let Some(card) = commander {
            let pile = category(c, id, "commander", "Commander");
            deck_card(c, id, card, pile, 1);
        }
        id
    }

    fn ids(list: &Value, key: &str) -> Vec<String> {
        list[key]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["comboId"].as_str().unwrap().to_owned())
            .collect()
    }

    #[tokio::test]
    async fn held_combos_reads_a_deck_s_active_piles_only() {
        let state = state("held-active");
        let mut deck = 0;
        seed(&state, |c| {
            for (card, name) in [("p-a", "Card A"), ("p-b", "Card B"), ("p-c", "Card C")] {
                combo_card(c, card, name, "U", true);
            }
            combo(c, "x", "R", &[CA, CB]);
            combo(c, "y", "P", &[CA, CC]);
            downloaded(c);
            deck = combo_deck(c, "casual", &["p-a", "p-c"], &["p-b"], None);
        });
        let got = done(&state, "held_combos", json!({ "deckId": deck })).await;
        assert_eq!(ids(&got, "complete"), ["y"]);
        assert_eq!(got["completeTotal"], 1);
        assert_eq!(ids(&got, "oneCardAway"), ["x"]);
        assert_eq!(got["oneCardAwayTotal"], 1);
        assert_eq!(got["oneCardAway"][0]["missing"]["name"], "Card B");
        assert_eq!(got["oneCardAway"][0]["missing"]["cardId"], "p-b");
        assert_eq!(got["oneCardAway"][0]["missing"]["owned"], 0);
        assert_eq!(got["comboData"]["downloadedAt"], 1_700_000_000);

        let only = done(
            &state,
            "held_combos",
            json!({ "deckId": deck, "oneCardAway": false }),
        )
        .await;
        assert!(only.get("oneCardAway").is_none());
        let why = refused(&state, "held_combos", json!({ "deckId": 9999 })).await;
        assert!(why.contains("list_decks"), "{why}");
    }

    #[tokio::test]
    async fn held_combos_offers_only_missing_cards_the_deck_can_play() {
        let state = state("held-playable");
        let mut deck = 0;
        seed(&state, |c| {
            combo_card(c, "p-a", "Card A", "U", true);
            combo_card(c, "p-cmd", "Commander", "U", true);
            combo_card(c, "p-blue", "Blue", "U", true);
            combo_card(c, "p-red", "Red", "R", true);
            combo_card(c, "p-banned", "Banned", "U", false);
            combo(c, "blue", "R", &[CA, ("o-p-blue", "Blue")]);
            combo(c, "red", "R", &[CA, ("o-p-red", "Red")]);
            combo(c, "banned", "R", &[CA, ("o-p-banned", "Banned")]);
            downloaded(c);
            deck = combo_deck(c, "commander", &["p-a"], &[], Some("p-cmd"));
        });
        let got = done(&state, "held_combos", json!({ "deckId": deck })).await;
        assert_eq!(ids(&got, "oneCardAway"), ["blue"], "{got}");
        assert!(
            got.get("note").is_none(),
            "a Commander deck needs no note: {got}"
        );
    }

    #[tokio::test]
    async fn a_colourless_commander_offers_only_colourless_missing_cards() {
        let state = state("held-colourless");
        let mut deck = 0;
        seed(&state, |c| {
            combo_card(c, "p-a", "Card A", "", true);
            combo_card(c, "p-cmd", "Commander", "", true);
            combo_card(c, "p-grey", "Grey", "", true);
            combo_card(c, "p-blue", "Blue", "U", true);
            combo(c, "grey", "R", &[CA, ("o-p-grey", "Grey")]);
            combo(c, "blue", "R", &[CA, ("o-p-blue", "Blue")]);
            downloaded(c);
            deck = combo_deck(c, "commander", &["p-a"], &[], Some("p-cmd"));
        });
        let got = done(&state, "held_combos", json!({ "deckId": deck })).await;
        assert_eq!(ids(&got, "oneCardAway"), ["grey"], "{got}");
    }

    #[tokio::test]
    async fn held_combos_without_a_deck_reads_the_collection() {
        let state = state("held-collection");
        seed(&state, |c| {
            for (card, name) in [("p-a", "Card A"), ("p-b", "Card B"), ("p-c", "Card C")] {
                combo_card(c, card, name, "U", true);
            }
            combo(c, "ab", "R", &[CA, CB]);
            combo(c, "ac", "P", &[CA, CC]);
            downloaded(c);
            grimoire_core::schema::fixtures::entry(c, "p-a", 1);
            grimoire_core::schema::fixtures::entry(c, "p-b", 1);
        });
        let got = done(&state, "held_combos", json!({})).await;
        assert_eq!(ids(&got, "complete"), ["ab"]);
        assert_eq!(ids(&got, "oneCardAway"), ["ac"]);
        assert_eq!(got["oneCardAway"][0]["missing"]["name"], "Card C");
        assert!(got.get("note").is_none(), "{got}");

        let why = refused(&state, "held_combos", json!({ "limit": 101 })).await;
        assert!(why.contains("limit"), "{why}");
    }

    #[tokio::test]
    async fn a_non_commander_deck_is_told_the_list_is_commander_s() {
        let state = state("held-note");
        let mut deck = 0;
        seed(&state, |c| {
            combo_card(c, "p-a", "Card A", "U", true);
            combo(c, "x", "R", &[CA, CB]);
            downloaded(c);
            deck = combo_deck(c, "casual", &["p-a"], &[], None);
        });
        let got = done(&state, "held_combos", json!({ "deckId": deck })).await;
        assert!(got["note"].as_str().unwrap().contains("Commander"), "{got}");
    }

    #[tokio::test]
    async fn a_combo_list_never_downloaded_says_so() {
        let state = state("combos-never");
        seed(&state, |c| {
            combo_card(c, "p-a", "Card A", "U", true);
            combo(c, "c1", "R", &[CA, CB]);
        });
        let calls = [
            ("card_combos", json!({ "cardId": "p-a" })),
            ("get_combo", json!({ "comboId": "c1" })),
            ("held_combos", json!({})),
        ];
        for (name, args) in calls {
            let got = done(&state, name, args).await;
            assert!(got["comboData"]["downloadedAt"].is_null(), "{name}: {got}");
            let note = got["note"].as_str().unwrap();
            assert!(note.contains("Settings"), "{name}: {got}");
            assert!(!note.contains("  "), "{name}: {note}");
        }
    }

    // ---- raw records, tags, similar cards and format rules -------------------------------

    /// A printing `id` of oracle card `o-<id>` named `name`, its `raw` a gzipped Scryfall object.
    fn raw_card(c: &rusqlite::Connection, id: &str, name: &str, raw: &Value) {
        grimoire_core::schema::fixtures::seed_card(c, id, "lea", "1");
        c.execute(
            "UPDATE cards SET name = ?2, raw = ?3 WHERE id = ?1",
            rusqlite::params![
                id,
                name,
                grimoire_core::card_row::gzip_raw(&raw.to_string())
            ],
        )
        .unwrap();
    }

    /// An oracle tag, and the oracle ids that hold it directly (and, here, through the closure).
    fn tag(c: &rusqlite::Connection, slug: &str, label: &str, holders: &[&str]) {
        c.execute(
            "INSERT OR IGNORE INTO oracle_tags (slug, id, label, description, slug_norm)
             VALUES (?1, ?2, ?3, 'About it.', ?1)",
            rusqlite::params![slug, format!("id-{slug}"), label],
        )
        .unwrap();
        for oracle in holders {
            for table in ["oracle_taggings", "oracle_tag_cards"] {
                c.execute(
                    &format!("INSERT INTO {table} (oracle_id, slug) VALUES (?1, ?2)"),
                    rusqlite::params![oracle, slug],
                )
                .unwrap();
            }
        }
    }

    fn tags_downloaded(c: &rusqlite::Connection) {
        c.execute(
            "INSERT INTO oracle_tag_meta (id, ingested_at, checked_at, tag_count, tagging_count)
             VALUES (1, 1700000200, 1700000300, 2, 3)",
            [],
        )
        .unwrap();
    }

    #[tokio::test]
    async fn card_scryfall_answers_the_record_without_image_or_shop_links() {
        let state = state("card-scryfall");
        seed(&state, |c| {
            raw_card(
                c,
                "p-a",
                "Card A",
                &json!({
                    "name": "Card A", "layout": "normal", "keywords": ["Flying"],
                    "image_uris": { "small": "x" }, "purchase_uris": { "a": "y" },
                    "related_uris": { "b": "z" }, "prices": { "usd": "1.00" },
                }),
            );
            raw_card(c, "p-b", "Card B", &json!({ "name": "Card B", "cmc": 2.0 }));
        });
        let got = done(
            &state,
            "card_scryfall",
            json!({ "cardIds": ["p-a", "p-b", "nope"] }),
        )
        .await;
        let a = &got["cards"][0];
        assert_eq!(a["cardId"], "p-a");
        assert_eq!(a["scryfall"]["keywords"], json!(["Flying"]));
        assert_eq!(a["scryfall"]["prices"]["usd"], "1.00");
        for gone in ["image_uris", "purchase_uris", "related_uris"] {
            assert!(a["scryfall"].get(gone).is_none(), "{gone} stayed: {a}");
        }
        assert_eq!(got["cards"][1]["scryfall"]["cmc"], 2.0);
        assert_eq!(got["cards"].as_array().unwrap().len(), 2);
        assert_eq!(got["missing"], json!(["nope"]));

        let only = done(
            &state,
            "card_scryfall",
            json!({ "cardIds": ["p-a"], "fields": ["keywords", "image_uris"] }),
        )
        .await;
        assert_eq!(
            only["cards"][0]["scryfall"],
            json!({ "keywords": ["Flying"], "image_uris": { "small": "x" } })
        );

        let ids: Vec<String> = (0..21).map(|i| format!("p-{i}")).collect();
        let why = refused(&state, "card_scryfall", json!({ "cardIds": ids })).await;
        assert!(why.contains("20"), "{why}");
        let why = refused(&state, "card_scryfall", json!({ "cardIds": [] })).await;
        assert!(why.contains("cardIds"), "{why}");
    }

    #[tokio::test]
    async fn a_two_faced_record_keeps_its_faces_text() {
        let state = state("card-scryfall-faces");
        seed(&state, |c| {
            raw_card(
                c,
                "p-dfc",
                "Front // Back",
                &json!({
                    "name": "Front // Back",
                    "card_faces": [
                        { "name": "Front", "oracle_text": "Front text.", "image_uris": { "small": "f" } },
                        { "name": "Back", "oracle_text": "Back text.", "image_uris": { "small": "b" } },
                    ],
                }),
            );
        });
        let got = done(&state, "card_scryfall", json!({ "cardIds": ["p-dfc"] })).await;
        let faces = got["cards"][0]["scryfall"]["card_faces"]
            .as_array()
            .unwrap();
        assert_eq!(faces.len(), 2);
        assert_eq!(faces[0]["oracle_text"], "Front text.");
        assert_eq!(faces[1]["oracle_text"], "Back text.");
        assert!(
            faces.iter().all(|f| f.get("image_uris").is_none()),
            "{faces:?}"
        );
    }

    #[tokio::test]
    async fn get_card_names_tags_related_cards_faces_and_a_combo_count() {
        let state = state("get-card-widened");
        seed(&state, |c| {
            raw_card(
                c,
                "p-a",
                "Card A",
                &json!({ "all_parts": [
                    { "id": "tok-1", "object": "related_card", "component": "token",
                      "name": "Spirit", "type_line": "Token Creature - Spirit" },
                ]}),
            );
            c.execute(
                "UPDATE cards SET faces = ?2 WHERE id = ?1",
                rusqlite::params![
                    "p-a",
                    json!([
                        { "name": "Front", "type_line": "Creature", "oracle_text": "Fly.", "mana_cost": "{U}" },
                        { "name": "Back", "type_line": "Land", "oracle_text": "Tap.", "artist": "Z" },
                    ])
                    .to_string()
                ],
            )
            .unwrap();
            combo_card(c, "p-b", "Card B", "U", true);
            combo(c, "c1", "R", &[("o-p-a", "Card A"), CB]);
            downloaded(c);
            tag(c, "ramp", "Ramp", &["o-p-a"]);
            tag(c, "draw", "Card advantage", &["o-p-a"]);
            tags_downloaded(c);
        });
        let got = done(&state, "get_card", json!({ "cardId": "p-a" })).await;
        assert_eq!(
            got["tags"],
            json!([
                { "slug": "draw", "label": "Card advantage" },
                { "slug": "ramp", "label": "Ramp" },
            ])
        );
        assert_eq!(got["tagData"]["downloadedAt"], 1_700_000_200);
        assert!(got.get("note").is_none(), "{got}");
        assert_eq!(got["related"][0]["relation"], "token");
        assert_eq!(got["related"][0]["name"], "Spirit");
        assert_eq!(got["comboCount"], 1);
        assert_eq!(got["comboData"]["downloadedAt"], 1_700_000_000);
        assert_eq!(
            got["faces"],
            json!([
                { "name": "Front", "typeLine": "Creature", "manaCost": "{U}", "oracleText": "Fly." },
                { "name": "Back", "typeLine": "Land", "oracleText": "Tap." },
            ])
        );
    }

    #[tokio::test]
    async fn an_untagged_card_has_no_tags_and_no_note() {
        let state = state("get-card-untagged");
        seed(&state, |c| {
            raw_card(c, "p-a", "Card A", &json!({}));
            tag(c, "ramp", "Ramp", &["o-other"]);
            tags_downloaded(c);
            downloaded(c);
        });
        let got = done(&state, "get_card", json!({ "cardId": "p-a" })).await;
        assert_eq!(got["tags"], json!([]));
        assert_eq!(got["tagData"]["downloadedAt"], 1_700_000_200);
        assert!(got.get("note").is_none(), "{got}");
        assert_eq!(got["related"], json!([]));
        assert_eq!(got["comboCount"], 0);
        assert!(
            got.get("faces").is_none(),
            "a one-faced card has none: {got}"
        );
    }

    #[tokio::test]
    async fn a_missing_tag_feed_says_so() {
        let state = state("get-card-no-tag-feed");
        seed(&state, |c| raw_card(c, "p-a", "Card A", &json!({})));
        let got = done(&state, "get_card", json!({ "cardId": "p-a" })).await;
        assert_eq!(got["tags"], json!([]));
        assert!(got["tagData"]["downloadedAt"].is_null(), "{got}");
        let note = got["note"].as_str().unwrap();
        assert!(
            note.contains("tag list") && note.contains("combo list"),
            "{got}"
        );
        assert!(!note.contains("  "), "{note}");
        assert!(got["comboData"]["downloadedAt"].is_null(), "{got}");
        assert_eq!(got["comboCount"], 0);

        let found = done(&state, "find_tags", json!({ "text": "ramp" })).await;
        assert_eq!(found["tags"], json!([]));
        assert!(found["tagData"]["downloadedAt"].is_null(), "{found}");
        let note = found["note"].as_str().unwrap();
        assert!(note.contains("Settings"), "{found}");
        assert!(!note.contains("  "), "{note}");
    }

    #[tokio::test]
    async fn find_tags_turns_words_into_slugs() {
        let state = state("find-tags");
        seed(&state, |c| {
            tag(c, "ramp", "Ramp", &["o-1", "o-2"]);
            tag(c, "mana-ramp", "Mana ramp", &["o-1"]);
            tags_downloaded(c);
        });
        let got = done(&state, "find_tags", json!({ "text": "ramp" })).await;
        assert_eq!(
            got["tags"][0],
            json!({ "slug": "ramp", "label": "Ramp", "cardCount": 2 })
        );
        assert_eq!(got["tags"][1]["slug"], "mana-ramp");
        assert_eq!(got["tagData"]["downloadedAt"], 1_700_000_200);
        assert!(got.get("note").is_none(), "{got}");

        let one = done(&state, "find_tags", json!({ "text": "ramp", "limit": 1 })).await;
        assert_eq!(one["tags"].as_array().unwrap().len(), 1);
        let why = refused(&state, "find_tags", json!({ "text": "ramp", "limit": 51 })).await;
        assert!(why.contains("limit"), "{why}");
        let why = refused(&state, "find_tags", json!({})).await;
        assert!(why.contains("text"), "{why}");
    }

    #[tokio::test]
    async fn similar_cards_ranks_by_shared_tags() {
        let state = state("similar-cards");
        seed(&state, |c| {
            for (id, name) in [("p-a", "Card A"), ("p-b", "Card B"), ("p-c", "Card C")] {
                combo_card(c, id, name, "U", true);
            }
            // A rare tag shared with B, a common one shared with C.
            tag(c, "rare", "Rare thing", &["o-p-a", "o-p-b"]);
            tag(
                c,
                "common",
                "Common thing",
                &["o-p-a", "o-p-c", "o-x", "o-y", "o-z"],
            );
            tags_downloaded(c);
        });
        let got = done(&state, "similar_cards", json!({ "cardId": "p-a" })).await;
        let names: Vec<&str> = got["cards"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["Card B", "Card C"], "{got}");
        let b = &got["cards"][0];
        assert_eq!(b["cardId"], "p-b");
        assert_eq!(b["sharedTags"], json!(["Rare thing"]));
        assert!(b["score"].as_f64().unwrap() > got["cards"][1]["score"].as_f64().unwrap());
        assert!(b.get("oracleId").is_none(), "{b}");
        assert_eq!(got["tagData"]["downloadedAt"], 1_700_000_200);

        let legal = done(
            &state,
            "similar_cards",
            json!({ "cardId": "p-a", "format": "Commander", "identity": "u", "limit": 1 }),
        )
        .await;
        assert_eq!(legal["cards"].as_array().unwrap().len(), 1);

        let why = refused(
            &state,
            "similar_cards",
            json!({ "cardId": "p-a", "format": "casual" }),
        )
        .await;
        assert!(why.contains("commander"), "{why}");
        assert!(!why.contains("  "), "{why}");
        let why = refused(&state, "similar_cards", json!({ "cardId": "nope" })).await;
        assert!(why.contains("No card has the id nope"), "{why}");
    }

    #[tokio::test]
    async fn format_rules_marks_which_formats_can_be_searched() {
        let state = state("format-rules");
        let all = done(&state, "format_rules", json!({})).await;
        let formats = all["formats"].as_array().unwrap();
        assert!(formats.len() > 10, "{all}");
        let by = |key: &str| formats.iter().find(|f| f["key"] == key);
        let commander = by("commander").expect("the picker offers commander");
        assert_eq!(commander["name"], "Commander");
        assert_eq!(commander["searchable"], true);
        assert_eq!(commander["singleton"], true);
        assert_eq!(commander["requiresCommander"], true);
        assert!(commander.get("restrictedMeaning").is_some(), "{commander}");
        assert!(commander.get("enabledInPicker").is_none(), "{commander}");
        assert!(by("casual").is_none_or(|f| f["searchable"] == false));

        let one = done(&state, "format_rules", json!({ "format": "Commander" })).await;
        assert_eq!(one["formats"].as_array().unwrap().len(), 1);
        assert_eq!(one["formats"][0]["key"], "commander");

        let why = refused(&state, "format_rules", json!({ "format": "nonesuch" })).await;
        assert!(why.contains("commander"), "{why}");
        assert!(!why.contains("  "), "{why}");
    }

    // ---- find_cards' filters ---------------------------------------------------------------

    /// A paper printing `id` named `name` with the columns the filters read.
    #[allow(clippy::too_many_arguments)]
    fn filter_card(
        c: &rusqlite::Connection,
        id: &str,
        name: &str,
        identity: &str,
        type_line: &str,
        cmc: f64,
        rarity: &str,
        commander_legal: bool,
        game_changer: bool,
    ) {
        grimoire_core::schema::fixtures::seed_card(c, id, "lea", "1");
        let legal = if commander_legal {
            grimoire_core::legalities::bit("commander").unwrap() as i64
        } else {
            0
        };
        c.execute(
            "UPDATE cards SET name = ?2, color_identity = ?3, type_line = ?4, type_mask = ?5,
                cmc = ?6, rarity = ?7, legal_mask = ?8, game_changer = ?9, is_paper = 1,
                search_text = ?2
             WHERE id = ?1",
            rusqlite::params![
                id,
                name,
                identity,
                type_line,
                grimoire_core::cardtypes::type_mask(type_line),
                cmc,
                rarity,
                legal,
                game_changer
            ],
        )
        .unwrap();
    }

    /// Three cards that differ on every filter's column.
    fn filter_cards(c: &rusqlite::Connection) {
        filter_card(
            c,
            "f-bolt",
            "Bolt Mage",
            "R",
            "Instant",
            1.0,
            "common",
            true,
            false,
        );
        filter_card(
            c,
            "f-drake",
            "Blue Drake",
            "U",
            "Creature - Drake",
            3.0,
            "rare",
            true,
            false,
        );
        filter_card(
            c,
            "f-gold",
            "Gold Thing",
            "UR",
            "Creature - Elemental",
            5.0,
            "mythic",
            false,
            true,
        );
        // The name index a `query` reads.
        c.execute_batch("INSERT INTO cards_fts(cards_fts) VALUES('rebuild');")
            .unwrap();
    }

    fn names(found: &Value) -> Vec<String> {
        let mut names: Vec<String> = found["cards"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["name"].as_str().unwrap().to_owned())
            .collect();
        names.sort();
        names
    }

    #[tokio::test]
    async fn find_cards_filters_by_format_colours_types_and_mana_value() {
        let state = state("find-cards-filters");
        seed(&state, filter_cards);
        let find = |filters: Value| {
            let state = state.clone();
            async move { done(&state, "find_cards", json!({ "filters": filters })).await }
        };
        assert_eq!(
            names(&find(json!({ "format": "commander" })).await),
            ["Blue Drake", "Bolt Mage"]
        );
        // Identity inside U: the blue card, not the gold one or the red one.
        assert_eq!(
            names(&find(json!({ "colors": ["U"] })).await),
            ["Blue Drake"]
        );
        assert_eq!(
            names(&find(json!({ "colors": ["U", "R"] })).await),
            ["Blue Drake", "Bolt Mage", "Gold Thing"]
        );
        assert_eq!(
            names(&find(json!({ "colors": ["U", "R"], "colorsExact": true })).await),
            ["Gold Thing"]
        );
        assert_eq!(
            names(&find(json!({ "types": ["Instant"] })).await),
            ["Bolt Mage"]
        );
        assert_eq!(
            names(&find(json!({ "types": ["Creature"], "rarities": ["mythic"] })).await),
            ["Gold Thing"]
        );
        assert_eq!(
            names(&find(json!({ "manaValues": [3] })).await),
            ["Blue Drake"]
        );
        assert_eq!(
            names(&find(json!({ "manaValues": [1, 8] })).await),
            ["Bolt Mage"]
        );
        assert_eq!(names(&find(json!({ "sets": ["lea"] })).await).len(), 3);
        // A query narrows beside the filters.
        let both = done(
            &state,
            "find_cards",
            json!({ "query": "bolt", "filters": { "format": "commander" } }),
        )
        .await;
        assert_eq!(names(&both), ["Bolt Mage"]);
    }

    #[tokio::test]
    async fn a_format_typed_with_capitals_is_accepted() {
        let state = state("find-cards-format-capitals");
        seed(&state, filter_cards);
        let got = done(
            &state,
            "find_cards",
            json!({ "filters": { "format": "Commander" } }),
        )
        .await;
        assert_eq!(names(&got), ["Blue Drake", "Bolt Mage"]);
    }

    #[tokio::test]
    async fn game_changers_are_a_filter() {
        let state = state("find-cards-game-changers");
        seed(&state, filter_cards);
        let got = done(
            &state,
            "find_cards",
            json!({ "filters": { "gameChanger": true } }),
        )
        .await;
        assert_eq!(names(&got), ["Gold Thing"]);
    }

    #[tokio::test]
    async fn oracle_tags_narrow_and_an_unknown_tag_is_refused_naming_find_tags() {
        let state = state("find-cards-oracle-tags");
        seed(&state, |c| {
            filter_cards(c);
            tag(c, "ramp", "Ramp", &["o-f-drake", "o-f-gold"]);
            tag(c, "removal", "Removal", &["o-f-gold", "o-f-bolt"]);
            tags_downloaded(c);
        });
        let got = done(
            &state,
            "find_cards",
            json!({ "filters": { "oracleTags": ["ramp"] } }),
        )
        .await;
        assert_eq!(names(&got), ["Blue Drake", "Gold Thing"]);
        let both = done(
            &state,
            "find_cards",
            json!({ "filters": { "oracleTags": ["ramp", "removal"] } }),
        )
        .await;
        assert_eq!(names(&both), ["Gold Thing"]);
        let why = refused(
            &state,
            "find_cards",
            json!({ "filters": { "oracleTags": ["ramp", "nonesuch"] } }),
        )
        .await;
        assert!(why.contains("find_tags"), "{why}");
        assert!(why.contains("nonesuch"), "{why}");
        assert!(!why.contains("  "), "{why}");
    }

    #[tokio::test]
    async fn an_unknown_filter_value_is_refused_naming_its_field() {
        let state = state("find-cards-bad-values");
        seed(&state, filter_cards);
        for (field, value) in [
            ("colors", json!(["X"])),
            ("types", json!(["Wizard"])),
            ("rarities", json!(["epic"])),
            ("format", json!("casual")),
            ("manaValues", json!([9])),
            ("nonsense", json!(true)),
        ] {
            let why = refused(&state, "find_cards", json!({ "filters": { field: value } })).await;
            assert!(why.contains(field), "{field}: {why}");
            assert!(!why.contains("  "), "{field}: {why}");
        }
    }

    #[tokio::test]
    async fn find_cards_needs_a_query_or_a_filter() {
        let state = state("find-cards-needs-something");
        let why = refused(&state, "find_cards", json!({})).await;
        assert!(why.contains("query") && why.contains("filters"), "{why}");
        assert!(!why.contains("  "), "{why}");
        let why = refused(&state, "find_cards", json!({ "filters": {} })).await;
        assert!(why.contains("filters"), "{why}");
    }

    #[tokio::test]
    async fn the_price_filters_read_the_readers_marketplace() {
        let state = state("find-cards-marketplace");
        seed(&state, |c| {
            filter_cards(c);
            // Cheap in dollars, dear in euros.
            c.execute(
                "UPDATE cards SET price_usd = 1.0, price_eur = 10.0 WHERE id = 'f-bolt'",
                [],
            )
            .unwrap();
        });
        let dear = json!({ "filters": { "priceMin": 5 } });
        // The default marketplace is TCGplayer: a dollar is below the floor.
        let got = done(&state, "find_cards", dear.clone()).await;
        assert!(names(&got).is_empty(), "{got}");
        seed(&state, |c| {
            grimoire_core::marketplace::store(c, "cardmarket").unwrap();
        });
        let got = done(&state, "find_cards", dear).await;
        assert_eq!(names(&got), ["Bolt Mage"], "{got}");
        assert_eq!(got["cards"][0]["price"], 10.0, "{got}");
        let cheap = json!({ "filters": { "priceMax": 5 } });
        assert!(names(&done(&state, "find_cards", cheap).await).is_empty());
    }

    #[tokio::test]
    async fn get_card_prices_in_the_readers_marketplace() {
        let state = state("get-card-marketplace");
        seed(&state, |c| {
            raw_card(c, "p-a", "Card A", &json!({}));
            c.execute(
                "UPDATE cards SET prices = ?1 WHERE id = 'p-a'",
                [json!({ "usd": "1.00", "eur": "10.00" }).to_string()],
            )
            .unwrap();
        });
        let got = done(&state, "get_card", json!({ "cardId": "p-a" })).await;
        assert_eq!(got["prices"]["nonfoil"], 1.0, "{got}");
        seed(&state, |c| {
            grimoire_core::marketplace::store(c, "cardmarket").unwrap();
        });
        let got = done(&state, "get_card", json!({ "cardId": "p-a" })).await;
        assert_eq!(got["prices"]["nonfoil"], 10.0, "{got}");
    }

    #[tokio::test]
    async fn get_card_caps_related_and_counts_the_rest() {
        let state = state("get-card-related-cap");
        let parts = |n: usize| {
            let all: Vec<Value> = (0..n)
                .map(|i| {
                    json!({ "id": format!("tok-{i}"), "object": "related_card",
                            "component": "token", "name": format!("Token {i}"),
                            "type_line": "Token Creature" })
                })
                .collect();
            json!({ "all_parts": all })
        };
        seed(&state, |c| {
            raw_card(c, "p-many", "Many", &parts(30));
            raw_card(c, "p-few", "Few", &parts(3));
        });
        let got = done(&state, "get_card", json!({ "cardId": "p-many" })).await;
        assert_eq!(got["related"].as_array().unwrap().len(), 25, "{got}");
        assert_eq!(got["relatedTotal"], 30, "{got}");
        let got = done(&state, "get_card", json!({ "cardId": "p-few" })).await;
        assert_eq!(got["related"].as_array().unwrap().len(), 3, "{got}");
        assert!(got.get("relatedTotal").is_none(), "{got}");
    }

    #[tokio::test]
    async fn held_combos_checks_the_collection_format_and_upper_cases_identity() {
        let state = state("held-collection-format");
        seed(&state, |c| {
            for (card, name) in [("p-a", "Card A"), ("p-b", "Card B"), ("p-c", "Card C")] {
                combo_card(c, card, name, "U", true);
            }
            combo(c, "ac", "P", &[CA, CC]);
            downloaded(c);
            grimoire_core::schema::fixtures::entry(c, "p-a", 1);
        });
        let got = done(&state, "held_combos", json!({ "format": "Commander" })).await;
        assert_eq!(ids(&got, "oneCardAway"), ["ac"], "{got}");
        let got = done(&state, "held_combos", json!({ "identity": "u" })).await;
        assert_eq!(ids(&got, "oneCardAway"), ["ac"], "{got}");
        let why = refused(&state, "held_combos", json!({ "format": "casual" })).await;
        assert!(why.contains("format") && why.contains("commander"), "{why}");
    }

    #[tokio::test]
    async fn a_missing_combo_with_no_list_says_the_list_is_missing() {
        let state = state("get-combo-missing-no-list");
        let why = refused(&state, "get_combo", json!({ "comboId": "nope" })).await;
        assert!(why.contains("No combo has the id nope"), "{why}");
        assert!(why.contains("Settings"), "{why}");
        assert!(!why.contains("  "), "{why}");
        seed(&state, downloaded);
        let why = refused(&state, "get_combo", json!({ "comboId": "nope" })).await;
        assert!(!why.contains("Settings"), "{why}");
    }
}
