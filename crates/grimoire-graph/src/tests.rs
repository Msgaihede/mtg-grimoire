//! The graph over a real database: the user schema on files, decks and notes written through
//! the core's own functions, and every answer read back through [`Graph::run`].

use std::sync::atomic::Ordering;
use std::sync::Arc;

use grimoire_core::deck_notes::{create_note, list_notes};
use grimoire_core::schema::fixtures::deck;
use grimoire_core::state::{fixtures::on_files, State};
use serde_json::{json, Value};

use crate::loaders::NOTE_BATCHES;
use crate::{Graph, MAX_DEPTH};

fn state(name: &str) -> Arc<State> {
    on_files(name, "http://127.0.0.1:1").0
}

fn answer(graph: &Graph, state: &Arc<State>, query: &str) -> Value {
    let response = graph.run(state, query, None, None, None);
    assert!(response.errors.is_empty(), "{:?}", response.errors);
    response.data.into_json().unwrap()
}

/// The printout is what `packages/ui/lib/graphql/parity.test.ts` holds to the page's graph, so a
/// change here is a reviewed diff. `GRAPH_SDL_WRITE=1 cargo test -p grimoire-graph` rewrites it.
#[test]
fn the_printed_schema_is_the_reviewed_one() {
    let sdl = Graph::new().sdl();
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/schema.graphql");
    if std::env::var_os("GRAPH_SDL_WRITE").is_some() {
        std::fs::write(path, &sdl).unwrap();
    }
    let want = include_str!("../schema.graphql");
    assert_eq!(sdl.trim_end(), want.replace("\r\n", "\n").trim_end());
}

/// Every root field names the roots the page re-asks it under, in the printout itself.
#[test]
fn every_root_field_carries_its_cache_roots() {
    let sdl = Graph::new().sdl();
    let query = &sdl[sdl.find("type Query").unwrap()..];
    let query = &query[..query.find("\n}").unwrap()];
    for name in [
        "decks",
        "deckValues",
        "deckNotes",
        "collectionSummary",
        "collectionFolders",
    ] {
        let at = query
            .find(&format!("\t{name}"))
            .unwrap_or_else(|| panic!("{name} is a root"));
        let line = &query[at..query[at..].find('\n').map_or(query.len(), |n| at + n)];
        assert!(line.contains("@invalidatedBy(roots: ["), "{name}: {line}");
    }
}

#[test]
fn decks_answer_with_their_notes_and_values() {
    let state = state("graph-decks");
    let (burn, storm, quiet) = {
        let conn = state.lock_db();
        let burn = deck(&conn, "Burn");
        let storm = deck(&conn, "Storm");
        let quiet = deck(&conn, "Quiet");
        create_note(&conn, burn, "Mana", "Fourteen sources.", &["o-bolt".into()]).unwrap();
        create_note(&conn, burn, "Cuts", "", &[]).unwrap();
        create_note(&conn, storm, "Lines", "Ritual.", &[]).unwrap();
        (burn, storm, quiet)
    };
    let data = answer(
        &Graph::new(),
        &state,
        "{ decks { id name notes { title cards { oracleId } } value { unpriced value } } }",
    );

    let decks = data["decks"].as_array().unwrap();
    assert_eq!(decks.len(), 3);
    let by_id = |id: i64| decks.iter().find(|d| d["id"] == json!(id)).unwrap();
    let titles = |id: i64| -> Vec<String> {
        by_id(id)["notes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n["title"].as_str().unwrap().to_owned())
            .collect()
    };
    let conn = state.lock_db_read();
    let want = |id: i64| -> Vec<String> {
        list_notes(&conn, id)
            .unwrap()
            .into_iter()
            .map(|n| n.title)
            .collect()
    };
    assert_eq!(titles(burn), want(burn));
    assert_eq!(titles(storm), want(storm));
    assert!(titles(quiet).is_empty());
    assert_eq!(
        by_id(burn)["notes"][0]["cards"],
        json!([{ "oracleId": "o-bolt" }])
    );
    // An empty deck is worth nothing priced: no value, nothing unpriced.
    assert_eq!(
        by_id(quiet)["value"],
        json!({ "unpriced": 0, "value": null })
    );
}

/// The batch is per level, not per deck: one execution, one notes read, however many decks.
#[test]
fn a_list_of_decks_costs_one_notes_read() {
    let state = state("graph-batch");
    {
        let conn = state.lock_db();
        for n in 0..12 {
            deck(&conn, &format!("Deck {n}"));
        }
    }
    let graph = Graph::new();
    // The counter is shared with any test running beside this one, so run twice and take the
    // smaller difference: a neighbour's batch can land inside one window, not inside both.
    let runs: Vec<usize> = (0..2)
        .map(|_| {
            let before = NOTE_BATCHES.load(Ordering::SeqCst);
            answer(&graph, &state, "{ decks { notes { id } } }");
            NOTE_BATCHES.load(Ordering::SeqCst) - before
        })
        .collect();
    assert_eq!(runs.into_iter().min(), Some(1));
}

#[test]
fn the_collection_answers_over_an_empty_cabinet() {
    let state = state("graph-collection");
    let data = answer(
        &Graph::new(),
        &state,
        "{ collectionSummary { totalCards entries value unpriced } collectionFolders { id name kind } }",
    );
    assert_eq!(
        data["collectionSummary"],
        json!({ "totalCards": 0, "entries": 0, "value": 0.0, "unpriced": 0 })
    );
    assert!(data["collectionFolders"].is_array());
}

#[test]
fn a_valid_document_has_no_problems() {
    let graph = Graph::new();
    assert_eq!(
        graph.validate("{ decks { id value(marketplace: cardmarket) { value } } }"),
        vec![]
    );
}

#[test]
fn a_wrong_field_is_named_with_where_it_is() {
    let problems = Graph::new().validate("{\n  decks {\n    id\n    nmae\n  }\n}");
    assert_eq!(problems.len(), 1, "{problems:?}");
    assert_eq!(
        problems[0].message,
        "type `Deck` does not have a field `nmae`"
    );
    assert_eq!((problems[0].line, problems[0].column), (Some(4), Some(5)));
}

#[test]
fn a_mutation_is_refused_as_read_only() {
    let problems = Graph::new().validate("mutation { decks { id } }");
    assert!(!problems.is_empty());
    assert!(
        problems
            .iter()
            .any(|p| p.message.contains("read-only") || p.message.contains("mutation")),
        "{problems:?}"
    );
}

#[test]
fn a_document_too_deep_is_refused_counting_through_fragments() {
    let nest = |n: usize| -> String {
        let mut s = "name".to_owned();
        for _ in 0..n {
            s = format!("ofType {{ {s} }}");
        }
        s
    };
    let graph = Graph::new();
    let ok = format!(
        "{{ __type(name: \"Query\") {{ {} }} }}",
        nest(MAX_DEPTH - 2)
    );
    assert_eq!(graph.validate(&ok), vec![]);
    let deep = format!(
        "{{ __type(name: \"Query\") {{ ...F }} }} fragment F on __Type {{ {} }}",
        nest(MAX_DEPTH - 1)
    );
    let problems = graph.validate(&deep);
    assert_eq!(
        problems
            .iter()
            .map(|p| p.message.as_str())
            .collect::<Vec<_>>(),
        vec![format!(
            "This document nests {} levels deep; the limit is {MAX_DEPTH}.",
            MAX_DEPTH + 1
        )]
    );
}

/// A root field is nullable, as on the page: one refused read nulls its own field and leaves the
/// rest of the document standing.
#[test]
fn root_fields_are_nullable() {
    let sdl = Graph::new().sdl();
    assert!(
        sdl.contains("\tdecks(archived: Boolean): [Deck!] @invalidatedBy"),
        "{sdl}"
    );
    assert!(sdl.contains("\tcollectionSummary("), "{sdl}");
    assert!(sdl.contains("): CollectionSummary @invalidatedBy"), "{sdl}");
}

/// The answer carries the document's cache roots, so the page needs no parser of its own to
/// know which invalidations re-ask it — through fragments, once each, sorted.
#[test]
fn an_answer_carries_the_roots_its_document_reads() {
    let state = state("graph-roots");
    let response = Graph::new().run(
        &state,
        "query Board { ...F collectionFolders { id } } fragment F on Query { decks { id } deckValues { deckId } }",
        None,
        None,
        None,
    );
    assert!(response.errors.is_empty(), "{:?}", response.errors);
    let roots = serde_json::to_value(&response.extensions["invalidatedBy"]).unwrap();
    assert_eq!(roots, json!(["collection", "decks"]));
    // Introspection reads nothing a write can change.
    assert!(Graph::new().roots_of("{ __typename }", None).is_empty());
}

/// A structured filter is read by the core's own `Deserialize` — the same JSON the Search page
/// sends — so a group's `terms`, an operator and a finish mean what they mean there.
#[test]
fn a_filter_input_is_the_core_s_card_filters() {
    use crate::filters::{
        CardFilterInput, PredicateField, PredicateInput, PredicateOp, TagTermsInput,
    };
    let input = CardFilterInput {
        colors: Some("UR".into()),
        colors_strict: Some(true),
        printed_finishes: Some(vec![crate::enums::Finish::Etched]),
        oracle_tags: Some(TagTermsInput {
            include: vec!["ramp".into()],
            exclude: vec![],
        }),
        predicates: Some(vec![PredicateInput {
            field: PredicateField::AnyOf,
            op: PredicateOp::Colon,
            value: String::new(),
            negated: true,
            terms: vec![PredicateInput {
                field: PredicateField::TypeLine,
                op: PredicateOp::Gte,
                value: "goblin".into(),
                negated: false,
                terms: vec![],
            }],
        }]),
        ..CardFilterInput::default()
    };
    let core = input.into_core().unwrap();
    assert_eq!(core.colors.as_deref(), Some("UR"));
    assert_eq!(core.colors_strict, Some(true));
    assert_eq!(core.printed_finishes, Some(vec!["etched".to_owned()]));
    assert_eq!(core.oracle_tags.unwrap().include, vec!["ramp".to_owned()]);
    let group = &core.predicates.unwrap()[0];
    assert!(group.negated);
    assert_eq!(group.terms.len(), 1);
    assert_eq!(format!("{:?}", group.terms[0].field), "TypeLine");
    assert_eq!(format!("{:?}", group.terms[0].op), "Gte");
}
