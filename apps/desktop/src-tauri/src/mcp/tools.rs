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
//! `search_wishlist`, `list_folders`, `list_decks` and `get_deck` over the reader's own.
//! **Writes**: `add_to_collection`, `add_to_wishlist` and `add_card_to_deck` — the three adds issue
//! #1396 names, each the press of the same name in the app. Nothing here changes or removes a row:
//! an agent proposing a deletion asks the reader, who has the app open.
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

/// Every tool, as `tools/list` answers it.
pub fn list() -> Vec<Value> {
    let read = json!({ "readOnlyHint": true, "openWorldHint": false });
    let add = json!({
        "readOnlyHint": false,
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
    });
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
    vec![
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
        _ => return Called::NoSuchTool,
    };
    match answered {
        Ok(answer) => Called::Done(answer),
        Err(why) => Called::Refused(why),
    }
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
        assert_eq!(names.len(), 10);
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), 10, "names are unique");
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

    #[test]
    fn only_the_three_adds_say_they_write() {
        let writes: Vec<String> = list()
            .iter()
            .filter(|t| t["annotations"]["readOnlyHint"] == false)
            .map(|t| t["name"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(
            writes,
            ["add_to_collection", "add_to_wishlist", "add_card_to_deck"]
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

    #[tokio::test]
    async fn an_unknown_tool_is_a_protocol_error_not_a_refusal() {
        let state = state("unknown-tool");
        assert!(matches!(
            call(&state, "drop_tables", json!({})).await,
            Called::NoSuchTool
        ));
    }
}
