//! **The read graph** — a read-only GraphQL schema over the reader's own data, answered from
//! SQLite through `grimoire-core`'s read functions.
//!
//! Linked by the desktop host alone (the owner's decision, 2026-10-29: no web or Android build
//! needs it), and spoken to through three doors that every caller shares:
//!
//! - [`Graph::sdl`] — the schema as text, what a model writing a widget is handed;
//! - [`Graph::validate`] — a document checked against the schema without running it, with
//!   every error's line and column, so a model can be told what it got wrong;
//! - [`Graph::run`] — a document executed against a [`State`]'s read connection.
//!
//! The desktop's `graphql_query` command and its MCP server both call these, and `cargo test`
//! calls them against an in-memory database. All three are **synchronous**: the caller is
//! already on a thread that may block (the blocking pool, a test), and a read in this app
//! never runs on an async worker.
//!
//! **One module per domain**, named after the `ipc` file whose reads it answers (`decks`,
//! `collection`, `wishlist`, `entry_tags`, `home`, `app`, `prefs`, `scanner`, `cards`, `tags`).
//! Each owns its root fields (a `…Query` struct merged into [`Query`]), its object types and its
//! batch loaders, which it puts on a request through its own `data` function — so a domain is
//! changed in its own file and nowhere else. Shared words are [`enums`]; a card search is
//! [`filters::CardFilterInput`].
//!
//! **Every root field is nullable** (`Result<Option<T>>`), so a refusal nulls that field alone
//! and the rest of a widget's document stands; below the root, nullability is the core's shape.
//! **Every root field carries `@invalidatedBy(roots: [...])`**: the query-cache roots the page
//! re-asks it under, returned with each answer ([`Graph::run`]'s `extensions.invalidatedBy`).

mod app;
mod cards;
mod collection;
mod decks;
mod entry_tags;
pub mod enums;
pub mod filters;
mod home;
mod loaders;
mod prefs;
mod scanner;
mod tags;
mod validate;
mod wishlist;

#[cfg(test)]
mod tests;

use std::sync::Arc;

use async_graphql::{
    EmptyMutation, EmptySubscription, Enum, MergedObject, Request, Response, Schema, TypeDirective,
    Variables,
};
use grimoire_core::state::State;

pub use validate::{Problem, MAX_DEPTH};

/// The roots of the page's query cache a root field's answer is stale under — the first segment
/// of the key the app's own reader of the same command uses. [`Graph::run`] returns the union a
/// document reads in `extensions.invalidatedBy`, which is how `useGraphQL` knows which
/// invalidations re-ask it.
#[TypeDirective(location = "FieldDefinition")]
pub(crate) fn invalidatedBy(roots: Vec<String>) {}

/// The roots as the directive takes them: `invalidatedBy::apply(roots(&["decks"]))` — the
/// derive accepts the directive only spelt as `<name>::apply(<args>)`, so the list is built here.
pub(crate) fn roots(roots: &[&str]) -> Vec<String> {
    roots.iter().map(|r| (*r).to_owned()).collect()
}

/// A marketplace prices are quoted at. Spelt as `MARKETPLACE_IDS` in `packages/ui/lib/
/// marketplace.ts`, lower-case, because that is how the page's graph spells them.
#[derive(Enum, Copy, Clone, Debug, PartialEq, Eq)]
#[graphql(rename_items = "lowercase")]
pub enum Marketplace {
    Tcgplayer,
    Cardmarket,
    Cardkingdom,
    Manapool,
    Cardtrader,
}

impl Marketplace {
    /// The id `grimoire_core::sorting::Marketplace::from_id` reads.
    pub fn id(self) -> &'static str {
        match self {
            Marketplace::Tcgplayer => "tcgplayer",
            Marketplace::Cardmarket => "cardmarket",
            Marketplace::Cardkingdom => "cardkingdom",
            Marketplace::Manapool => "manapool",
            Marketplace::Cardtrader => "cardtrader",
        }
    }
}

/// What one execution carries: the marketplace a priced field with no `marketplace` argument
/// answers at.
pub(crate) struct Defaults {
    pub marketplace: String,
}

/// The id of the marketplace a field answers at — its own argument, or the execution's.
/// `grimoire_core::sorting::Marketplace::from_id` reads it.
pub(crate) fn marketplace_of(ctx: &async_graphql::Context<'_>, arg: Option<Marketplace>) -> String {
    match arg {
        Some(m) => m.id().to_owned(),
        None => ctx.data_unchecked::<Defaults>().marketplace.clone(),
    }
}

/// Run `read` on the read connection and turn the core's `Err(String)` into a GraphQL error.
///
/// The lock is taken and dropped inside this call, never held across an `.await` — a
/// `MutexGuard` is not `Send`, so a resolver that tried would not compile.
pub(crate) fn read<T>(
    ctx: &async_graphql::Context<'_>,
    read: impl FnOnce(&rusqlite::Connection) -> Result<T, String>,
) -> async_graphql::Result<T> {
    let state = ctx.data_unchecked::<Arc<State>>();
    read(&state.lock_db_read()).map_err(async_graphql::Error::new)
}

#[derive(MergedObject, Default)]
pub struct Query(
    app::AppQuery,
    cards::CardsQuery,
    collection::CollectionQuery,
    decks::DecksQuery,
    entry_tags::EntryTagsQuery,
    home::HomeQuery,
    prefs::PrefsQuery,
    scanner::ScannerQuery,
    tags::TagsQuery,
    wishlist::WishlistQuery,
);

pub type GraphSchema = Schema<Query, EmptyMutation, EmptySubscription>;

/// The schema, built once; cheap to share between threads.
#[derive(Clone)]
pub struct Graph {
    schema: GraphSchema,
    /// The printout read back by apollo-compiler, for [`Graph::validate`].
    checked: Arc<apollo_compiler::validation::Valid<apollo_compiler::Schema>>,
}

impl Default for Graph {
    fn default() -> Self {
        Self::new()
    }
}

impl Graph {
    pub fn new() -> Self {
        let schema = Schema::build(Query::default(), EmptyMutation, EmptySubscription)
            // The page's graph counts the same way (`MAX_DEPTH` in `execute.ts`), and
            // [`Graph::validate`] reports it in words; this is the backstop for `run`.
            .limit_depth(MAX_DEPTH + 1)
            .finish();
        let checked = Arc::new(validate::schema(&sdl_of(&schema)));
        Self { schema, checked }
    }

    /// The schema as SDL, sorted, with the `@invalidatedBy` roots on every root field.
    pub fn sdl(&self) -> String {
        sdl_of(&self.schema)
    }

    /// Check a document against the schema without running it. Empty is valid.
    pub fn validate(&self, query: &str) -> Vec<Problem> {
        validate::validate(&self.checked, query)
    }

    /// The query-cache roots a document's root fields are stale under — the union of their
    /// `@invalidatedBy` roots, sorted. Empty for a document that names no root field it knows.
    pub fn roots_of(&self, query: &str, operation_name: Option<&str>) -> Vec<String> {
        validate::roots_of(&self.checked, query, operation_name)
    }

    /// Execute one read against `state`'s read connection. `marketplace` is what a priced field
    /// with no `marketplace` argument answers at; `None` reads the reader's stored choice.
    ///
    /// Never fails as a call: a syntax, validation or resolver error is an entry in the
    /// response's `errors`, beside whatever `data` the rest of the document answered. The
    /// document's cache roots ([`Graph::roots_of`]) ride in `extensions.invalidatedBy`.
    pub fn run(
        &self,
        state: &Arc<State>,
        query: &str,
        variables: Option<serde_json::Value>,
        operation_name: Option<&str>,
        marketplace: Option<String>,
    ) -> Response {
        let marketplace = marketplace
            .unwrap_or_else(|| grimoire_core::marketplace::stored(&state.lock_db_read()));
        let mut request = Request::new(query)
            .data(state.clone())
            .data(Defaults { marketplace });
        for data in [
            app::data,
            cards::data,
            collection::data,
            decks::data,
            entry_tags::data,
            home::data,
            prefs::data,
            scanner::data,
            tags::data,
            wishlist::data,
        ] {
            request = data(request, state);
        }
        if let Some(variables) = variables {
            request = request.variables(Variables::from_json(variables));
        }
        if let Some(name) = operation_name {
            request = request.operation_name(name);
        }
        let mut response = futures_executor::block_on(self.schema.execute(request));
        let roots = self.roots_of(query, operation_name);
        response.extensions.insert(
            "invalidatedBy".to_owned(),
            async_graphql::Value::List(
                roots
                    .into_iter()
                    .map(async_graphql::Value::String)
                    .collect(),
            ),
        );
        response
    }
}

fn sdl_of(schema: &GraphSchema) -> String {
    schema.sdl_with_options(
        async_graphql::SDLExportOptions::new()
            .sorted_fields()
            .sorted_arguments()
            .sorted_enum_items(),
    )
}
