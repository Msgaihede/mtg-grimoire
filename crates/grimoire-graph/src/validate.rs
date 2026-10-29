//! A document checked against the schema without running it — the MCP server's answer to a
//! model's draft, with each error's line and column so the model can be told where.
//!
//! async-graphql validates only on the way into an execution, so this reads the schema's own
//! printout ([`crate::Graph::sdl`]) with apollo-compiler, which checks every rule of the
//! specification, and adds the graph's two of its own — the same two the page's graph adds
//! (`packages/ui/lib/graphql/execute.ts`):
//!
//! - **queries only** — there is no `Mutation` type, and a `mutation` or `subscription` is
//!   refused in words of its own rather than as a missing root;
//! - **a depth limit** ([`MAX_DEPTH`]), counted through fragments, so a generated document
//!   cannot turn a nested relation into a read per row per level.

use std::collections::HashSet;

use apollo_compiler::executable::{ExecutableDocument, OperationType, Selection, SelectionSet};
use apollo_compiler::validation::Valid;
use apollo_compiler::Schema;
use serde::Serialize;

/// How many selection sets deep a document may nest — `execute.ts`'s `MAX_DEPTH`.
pub const MAX_DEPTH: usize = 8;

/// One thing wrong with a document. `line` and `column` count from 1, and are absent for a
/// problem with no one place (an operation the document does not hold).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Problem {
    pub message: String,
    pub line: Option<usize>,
    pub column: Option<usize>,
}

pub(crate) fn schema(sdl: &str) -> Valid<Schema> {
    // The schema is this crate's own printout; one it cannot read back is a bug here, which
    // `the_printed_schema_is_valid_graphql` catches before any caller can.
    Schema::parse_and_validate(sdl, "schema.graphql").expect("the graph's own SDL is valid")
}

pub(crate) fn validate(schema: &Valid<Schema>, query: &str) -> Vec<Problem> {
    let doc = match ExecutableDocument::parse_and_validate(schema, query, "query.graphql") {
        Ok(doc) => doc,
        Err(with) => {
            return with
                .errors
                .iter()
                .map(|d| {
                    let at = d.line_column_range().map(|r| r.start);
                    Problem {
                        message: d.error.to_string(),
                        line: at.map(|a| a.line),
                        column: at.map(|a| a.column),
                    }
                })
                .collect()
        }
    };
    let mut problems = Vec::new();
    for op in doc.operations.iter() {
        let at = op
            .location()
            .and_then(|l| l.line_column_range(&doc.sources))
            .map(|r| r.start);
        let problem = |message: String| Problem {
            message,
            line: at.map(|a| a.line),
            column: at.map(|a| a.column),
        };
        if op.operation_type != OperationType::Query {
            problems.push(problem(format!(
                "This graph is read-only: a {} operation is not accepted.",
                op.operation_type
            )));
        }
        let depth = depth_of(&doc, &op.selection_set, &mut HashSet::new());
        if depth > MAX_DEPTH {
            problems.push(problem(format!(
                "This document nests {depth} levels deep; the limit is {MAX_DEPTH}."
            )));
        }
    }
    problems
}

/// The deepest selection set under `set`, counting `set` itself as one — `execute.ts`'s
/// `depthOf`, so both graphs refuse the same documents. A fragment already on the path is the
/// specification's cycle error, which validation has reported; `seen` only stops the walk.
fn depth_of<'a>(
    doc: &'a Valid<ExecutableDocument>,
    set: &'a SelectionSet,
    seen: &mut HashSet<&'a str>,
) -> usize {
    let mut deepest = 0;
    for sel in &set.selections {
        let below = match sel {
            Selection::Field(f) if !f.selection_set.selections.is_empty() => {
                depth_of(doc, &f.selection_set, seen)
            }
            Selection::Field(_) => 0,
            Selection::InlineFragment(i) => depth_of(doc, &i.selection_set, seen) - 1,
            Selection::FragmentSpread(s) => {
                let name = s.fragment_name.as_str();
                match doc.fragments.get(&s.fragment_name) {
                    Some(frag) if seen.insert(name) => {
                        let d = depth_of(doc, &frag.selection_set, seen) - 1;
                        seen.remove(name);
                        d
                    }
                    _ => 0,
                }
            }
        };
        deepest = deepest.max(below);
    }
    deepest + 1
}
