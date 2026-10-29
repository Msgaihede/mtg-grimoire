//! The read graph's door from the page: `graphql_query`, one document in and one GraphQL
//! response out. The graph itself — the schema, the batches, validation — is
//! `crates/grimoire-graph`'s; this file only finds the state and the thread.
//!
//! The MCP server reaches the same [`Graph`] through the same three methods (`sdl`, `validate`,
//! `run`), so what a model is told about a document is what the page gets when it runs it.

use std::sync::{Arc, OnceLock};

use grimoire_graph::Graph;

use crate::sync::AppState;

/// The one schema this process builds — the page's command and the MCP server's three graph
/// tools (`mcp::tools`) both answer from it. Built on first use; cheap to share.
pub fn graph() -> &'static Graph {
    static GRAPH: OnceLock<Graph> = OnceLock::new();
    GRAPH.get_or_init(Graph::new)
}

/// Run one read of the graph. **Read-only** connection, blocking pool — as every read in this
/// app is. Never an `Err` for a bad document: a syntax, validation or resolver error is an
/// entry in the response's `errors`, beside whatever `data` the rest answered. `marketplace` is
/// the window's (its host fallback applied); absent, the stored choice.
#[tauri::command]
pub async fn graphql_query(
    state: tauri::State<'_, Arc<AppState>>,
    query: String,
    variables: Option<serde_json::Value>,
    operation_name: Option<String>,
    marketplace: Option<String>,
) -> Result<serde_json::Value, String> {
    let core = state.core.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let response = graph().run(
            &core,
            &query,
            variables,
            operation_name.as_deref(),
            marketplace,
        );
        serde_json::to_value(response).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("the graph could not be read: {e}"))?
}
