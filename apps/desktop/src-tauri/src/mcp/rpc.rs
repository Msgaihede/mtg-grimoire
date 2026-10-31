//! JSON-RPC 2.0, and the four MCP methods a tool server answers.
//!
//! `initialize` (the version handshake and what this server offers), `ping`, `tools/list` and
//! `tools/call`. Every notification is accepted and none needs an answer — `initialized` changes
//! nothing for a server that keeps no session, and a `cancelled` arrives after a tool call that
//! answers in milliseconds has already answered. A batch (an array, which the 2025-03-26 revision
//! allows and later ones dropped) is answered message by message, so a client of any revision is
//! served.
//!
//! **A tool that fails is not a JSON-RPC error.** MCP draws the line there: a protocol error is the
//! client's mistake (an unknown method, an unknown tool), and a tool's refusal — a folder that does
//! not exist, a card the database does not have — is a result with `isError: true` and the refusal
//! as its text, which the agent reads and can act on. Every refusal the core writes is a sentence
//! for a reader, so it is passed through as it is.

use super::{prompts, tools};
use crate::sync::AppState;
use serde_json::{json, Map, Value};
use std::sync::Arc;

/// The revisions this server speaks, newest first. Its whole surface — tools with a JSON result and
/// no streams — is common to all four, so the answer to `initialize` is the client's own revision
/// when it is one of these and the newest otherwise, as the lifecycle section asks.
pub const SUPPORTED_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;

/// What a client is told about this server when it connects — MCP's `instructions`, which a
/// client may put in front of its model.
const INSTRUCTIONS: &str = "MTG Grimoire is the user's Magic: The Gathering collection manager. \
These tools read the user's own collection, wishlist and decks on this computer, and the whole \
card database; they never change the user's cards, decks or wishlists — for that, the user uses \
the app. Card identities are Scryfall printing ids (cardId): use find_cards to turn a card name \
into one. Folders and decks are named by numeric ids from list_folders and list_decks. For \
searches beyond a name, and for anything else in the user's data, the read graph answers \
(graph_schema, graph_query). The one thing these tools write is the user's custom home-page \
widgets (widget_create, widget_update, widget_delete). Three prompts explain the work: \
search_cards, graphql_discovery and create_widget.";

/// What [`handle`] made of a request body.
pub enum Outcome {
    /// A JSON body to answer with `200`.
    Answer(String),
    /// Nothing to answer — only notifications or responses arrived: `202` and no body.
    Accepted,
    /// The body was not JSON-RPC at all: `400`, with the error object as the body.
    Malformed(String),
}

/// Answer one request body.
pub async fn handle(state: &Arc<AppState>, body: &[u8]) -> Outcome {
    let message: Value = match serde_json::from_slice(body) {
        Ok(message) => message,
        Err(e) => {
            return Outcome::Malformed(
                error(Value::Null, PARSE_ERROR, &format!("Not JSON: {e}")).to_string(),
            )
        }
    };
    match message {
        Value::Array(batch) if batch.is_empty() => {
            Outcome::Malformed(error(Value::Null, INVALID_REQUEST, "An empty batch.").to_string())
        }
        Value::Array(batch) => {
            let mut answers = Vec::new();
            for message in batch {
                if let Some(answer) = one(state, message).await {
                    answers.push(answer);
                }
            }
            if answers.is_empty() {
                Outcome::Accepted
            } else {
                Outcome::Answer(Value::Array(answers).to_string())
            }
        }
        message => match one(state, message).await {
            Some(answer) => Outcome::Answer(answer.to_string()),
            None => Outcome::Accepted,
        },
    }
}

/// One message: a request is answered, a notification or a response is not.
async fn one(state: &Arc<AppState>, message: Value) -> Option<Value> {
    let Value::Object(message) = message else {
        return Some(error(
            Value::Null,
            INVALID_REQUEST,
            "A JSON-RPC message is an object.",
        ));
    };
    let method = message.get("method").and_then(Value::as_str);
    let id = message.get("id").cloned();
    match (method, id) {
        // A response to a request this server never sends, or a notification: nothing to say.
        (None, _) if message.contains_key("result") || message.contains_key("error") => None,
        (Some(_), None) => None,
        (None, id) => Some(error(
            id.unwrap_or(Value::Null),
            INVALID_REQUEST,
            "A request needs a method.",
        )),
        (Some(method), Some(id)) => {
            let params = message.get("params").cloned().unwrap_or(Value::Null);
            Some(match call(state, method, params).await {
                Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                Err((code, text)) => error(id, code, &text),
            })
        }
    }
}

/// A request's result, or its JSON-RPC error.
async fn call(state: &Arc<AppState>, method: &str, params: Value) -> Result<Value, (i64, String)> {
    match method {
        "initialize" => Ok(initialize(&params)),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tools::list() })),
        "prompts/list" => Ok(json!({ "prompts": prompts::list() })),
        "prompts/get" => {
            let name = params.get("name").and_then(Value::as_str).ok_or((
                INVALID_PARAMS,
                "prompts/get needs a prompt name.".to_owned(),
            ))?;
            prompts::get(name, params.get("arguments"))
                .ok_or((INVALID_PARAMS, format!("There is no prompt named {name}.")))
        }
        "tools/call" => {
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .ok_or((INVALID_PARAMS, "tools/call needs a tool name.".to_owned()))?;
            let arguments = match params.get("arguments") {
                None | Some(Value::Null) => Value::Object(Map::new()),
                Some(Value::Object(arguments)) => Value::Object(arguments.clone()),
                Some(_) => {
                    return Err((
                        INVALID_PARAMS,
                        "A tool's arguments are an object.".to_owned(),
                    ))
                }
            };
            match tools::call(state, name, arguments).await {
                tools::Called::Done(answer) => Ok(json!({
                    "content": [{ "type": "text", "text": answer.to_string() }],
                    "isError": false,
                })),
                tools::Called::Refused(why) => Ok(json!({
                    "content": [{ "type": "text", "text": why }],
                    "isError": true,
                })),
                tools::Called::NoSuchTool => {
                    Err((INVALID_PARAMS, format!("There is no tool named {name}.")))
                }
            }
        }
        _ => Err((
            METHOD_NOT_FOUND,
            format!("This server does not answer {method}."),
        )),
    }
}

/// The handshake's answer: a revision both sides speak, what this server offers, and who it is.
fn initialize(params: &Value) -> Value {
    let asked = params.get("protocolVersion").and_then(Value::as_str);
    let version = asked
        .filter(|v| SUPPORTED_VERSIONS.contains(v))
        .unwrap_or(SUPPORTED_VERSIONS[0]);
    json!({
        "protocolVersion": version,
        "capabilities": {
            "tools": { "listChanged": false },
            "prompts": { "listChanged": false },
        },
        "serverInfo": {
            "name": "mtg-grimoire",
            "title": "MTG Grimoire",
            "version": env!("CARGO_PKG_VERSION"),
        },
        "instructions": INSTRUCTIONS,
    })
}

fn error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_handshake_keeps_a_known_revision_and_offers_the_newest_otherwise() {
        let known = initialize(&json!({ "protocolVersion": "2025-03-26" }));
        assert_eq!(known["protocolVersion"], "2025-03-26");
        let unknown = initialize(&json!({ "protocolVersion": "1999-01-01" }));
        assert_eq!(unknown["protocolVersion"], SUPPORTED_VERSIONS[0]);
        assert_eq!(unknown["serverInfo"]["name"], "mtg-grimoire");
        assert_eq!(unknown["capabilities"]["tools"]["listChanged"], false);
        assert_eq!(unknown["capabilities"]["prompts"]["listChanged"], false);
    }

    #[test]
    fn the_error_object_is_json_rpc_s() {
        let e = error(json!(7), METHOD_NOT_FOUND, "nope");
        assert_eq!(e["jsonrpc"], "2.0");
        assert_eq!(e["id"], 7);
        assert_eq!(e["error"]["code"], -32601);
    }
}
