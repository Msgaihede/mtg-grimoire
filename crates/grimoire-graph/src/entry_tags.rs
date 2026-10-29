//! The entry tags domain of the graph — to be ported from the page's graph
//! (`packages/ui/lib/graphql/schema/entryTags.ts`).

use std::sync::Arc;

use async_graphql::Request;
use grimoire_core::state::State;

/// This domain's batch loaders, for one execution.
pub(crate) fn data(request: Request, _state: &Arc<State>) -> Request {
    request
}

/// No root fields yet: an object type with none, so it merges into `Query` as nothing.
pub type EntryTagsQuery = async_graphql::EmptyMutation;
