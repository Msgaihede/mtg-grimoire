//! **Scryfall syntax in the tools** — `find_cards`, `search_collection` and `search_wishlist`'s
//! `syntax` argument, and the keyword reference the `scryfall_syntax` prompt closes with.
//!
//! The parse is the page's, ported (`grimoire_core::query_language`); this module is the
//! translation onto the search commands, as `tools.rs` is for every other argument:
//!
//! 1. [`query_language::read`] — the parse, or every term the tools would not apply as written,
//!    refused together (the owner's decision, 2026-11-25: syntax runs as written or not at all).
//! 2. **Every tag it names is resolved first**, top-level and inside groups alike, in one
//!    `tag_resolve`; an unknown one is refused with its closest names from `tag_search`. The page
//!    lets an unknown tag inside an `or` match nothing in its branch, because a reader can see
//!    the wall; an agent cannot, so it is refused here too (spec §9).
//! 3. The top-level tags become the request's `oracleTags`/`artTags`, merged with whatever the
//!    tool's own arguments put there (a union, `mergeTagTerms`' rule); a tag inside a group stays
//!    in its group, which the SQL resolves by name. The free text joins the request's `text`; the
//!    predicates join its `predicates`.
//!
//! Spec: `docs/superpowers/specs/2026-11-25-mcp-scryfall-syntax-design.md` §5.4.

use super::tools::run;
use crate::sync::AppState;
use grimoire_core::filters::{PredicateField, PredicateOp, QueryPredicate};
use grimoire_core::query_language::{
    self, sign_of, KeywordSpec, ParsedQuery, TagNamespace, Target, QUERY_KEYWORDS, QUERY_SECTIONS,
};
use serde_json::{json, Map, Value};
use std::sync::Arc;

/// The most tags one search may name — `tag_resolve`'s own cap (`MAX_LOOKUPS`), past which it
/// answers nothing.
const MAX_TAGS: usize = 64;

/// How many near names an unknown tag is offered — the page's "Did you mean" note.
const SUGGESTIONS: i64 = 3;

/// `syntax` read into a search request's fields: `text`, `oracleTags`, `artTags` and
/// `predicates`, laid over what `req` already holds (see the module doc for how each merges).
pub(super) async fn apply(
    state: &Arc<AppState>,
    syntax: &str,
    req: &mut Map<String, Value>,
) -> Result<(), String> {
    let parsed = query_language::read(syntax).map_err(|unread| {
        let sentences: Vec<String> = unread.into_iter().map(|u| u.sentence).collect();
        format!(
            "syntax cannot be applied as written. {}",
            sentences.join(" ")
        )
    })?;
    let slugs = resolve(state, &parsed).await?;
    let text = [
        req.get("text").and_then(Value::as_str),
        Some(parsed.text.as_str()),
    ]
    .into_iter()
    .flatten()
    .map(str::trim)
    .filter(|t| !t.is_empty())
    .collect::<Vec<_>>()
    .join(" ");
    req.insert(
        "text".into(),
        if text.is_empty() {
            Value::Null
        } else {
            json!(text)
        },
    );
    for (namespace, key) in [
        (TagNamespace::Oracle, "oracleTags"),
        (TagNamespace::Art, "artTags"),
    ] {
        let mut include = listed(req, key, "include");
        let mut exclude = listed(req, key, "exclude");
        for (tag, slug) in parsed.tags.iter().zip(&slugs) {
            if tag.namespace == namespace {
                let list = if tag.negated {
                    &mut exclude
                } else {
                    &mut include
                };
                if !list.contains(slug) {
                    list.push(slug.clone());
                }
            }
        }
        if !include.is_empty() || !exclude.is_empty() {
            req.insert(
                key.into(),
                json!({ "include": include, "exclude": exclude }),
            );
        }
    }
    let mut predicates: Vec<Value> = parsed
        .predicates
        .iter()
        .map(|token| serde_json::to_value(&token.predicate).expect("a predicate serialises"))
        .collect();
    if let Some(Value::Array(theirs)) = req.get("predicates") {
        predicates.extend(theirs.iter().cloned());
    }
    if !predicates.is_empty() {
        req.insert("predicates".into(), Value::Array(predicates));
    }
    Ok(())
}

/// One of a `TagTerms` object's two lists, as `req` holds it now.
fn listed(req: &Map<String, Value>, key: &str, list: &str) -> Vec<String> {
    req.get(key)
        .and_then(|terms| terms.get(list))
        .and_then(Value::as_array)
        .map(|slugs| {
            slugs
                .iter()
                .filter_map(|s| s.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// Every tag a parse names, top-level tokens first (in order) and then those inside groups.
fn named_tags(parsed: &ParsedQuery) -> Vec<(TagNamespace, String)> {
    fn walk(predicate: &QueryPredicate, out: &mut Vec<(TagNamespace, String)>) {
        match predicate.field {
            PredicateField::OracleTag => out.push((TagNamespace::Oracle, predicate.value.clone())),
            PredicateField::ArtTag => out.push((TagNamespace::Art, predicate.value.clone())),
            _ => predicate.terms.iter().for_each(|t| walk(t, out)),
        }
    }
    let mut out: Vec<(TagNamespace, String)> = parsed
        .tags
        .iter()
        .map(|t| (t.namespace, t.value.clone()))
        .collect();
    for token in &parsed.predicates {
        walk(&token.predicate, &mut out);
    }
    out
}

/// The slug of each top-level tag token, in order, once every tag the parse names has resolved —
/// or one refusal naming every one that did not, with its closest names.
async fn resolve(state: &Arc<AppState>, parsed: &ParsedQuery) -> Result<Vec<String>, String> {
    let named = named_tags(parsed);
    if named.is_empty() {
        return Ok(Vec::new());
    }
    if named.len() > MAX_TAGS {
        return Err(format!(
            "syntax names {} tags; a search takes at most {MAX_TAGS}.",
            named.len()
        ));
    }
    let asks: Vec<Value> = named
        .iter()
        .map(|(namespace, value)| json!({ "namespace": namespace.as_str(), "value": value }))
        .collect();
    let resolved = run(state, "tag_resolve", json!({ "asks": asks })).await?;
    let resolved = resolved.as_array().cloned().unwrap_or_default();
    let slug_of = |i: usize| {
        resolved
            .get(i)
            .and_then(|hit| hit.get("slug"))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    let mut unknown = Vec::new();
    for (i, (namespace, value)) in named.iter().enumerate() {
        if slug_of(i).is_some() {
            continue;
        }
        let near = run(
            state,
            "tag_search",
            json!({ "text": value, "namespace": namespace.as_str(), "limit": SUGGESTIONS }),
        )
        .await
        .ok();
        let near: Vec<String> = near
            .as_ref()
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|t| t.get("slug").and_then(Value::as_str))
            .map(|slug| format!("{slug:?}"))
            .collect();
        let taxonomy = match namespace {
            TagNamespace::Oracle => "oracle",
            TagNamespace::Art => "art",
        };
        let sentence = if near.is_empty() {
            format!("There is no {taxonomy} tag called {value:?}.")
        } else {
            format!(
                "There is no {taxonomy} tag called {value:?}; the closest are {}.",
                near.join(", ")
            )
        };
        if !unknown.contains(&sentence) {
            unknown.push(sentence);
        }
    }
    if !unknown.is_empty() {
        return Err(format!(
            "syntax names a tag that does not exist. {} find_tags looks oracle tags up by words.",
            unknown.join(" ")
        ));
    }
    Ok((0..parsed.tags.len())
        .map(|i| slug_of(i).expect("every tag resolved"))
        .collect())
}

/// What a bare `:` means for a row, in a word or two.
fn colon_means(spec: &KeywordSpec) -> &'static str {
    match (spec.target, spec.default_op) {
        (Target::Tag(_), _) => "has the tag",
        (
            Target::Field(PredicateField::Is | PredicateField::Has | PredicateField::NewFeature),
            _,
        ) => "is",
        (Target::Field(PredicateField::ColorIdentity), PredicateOp::Lte) => "fits inside",
        // A whole keyword ability, never part of one: `kw:fly` finds no fliers.
        (Target::Field(PredicateField::Keyword), _) => "has the ability",
        (
            Target::Field(
                PredicateField::Name | PredicateField::TypeLine | PredicateField::OracleText,
            ),
            _,
        ) => "a word starts with",
        (_, PredicateOp::Colon) => "contains",
        (_, PredicateOp::Eq) => "equals",
        (_, PredicateOp::Gte) => "at least",
        (_, PredicateOp::Lte) => "at most",
        _ => "",
    }
}

/// **The keyword reference** the `scryfall_syntax` prompt closes with: every row of the parser's
/// keyword table, grouped by the F1 panel's sections, with every spelling, the signs it takes,
/// what a bare `:` means and its example. Generated, so the prompt cannot name a keyword the
/// parser does not read; the table is held to the page's own by the golden.
pub fn keyword_reference() -> String {
    let mut out = String::from(concat!(
        "## Every keyword\n\n",
        "Generated from the parser's own table. A leading `-` negates any of them. ",
        "\"`:` means\" is what a bare `:` asks for that keyword, which is not the same twice.\n",
    ));
    for section in QUERY_SECTIONS {
        out.push_str(&format!(
            "\n### {section}\n\n| Keywords | Signs | `:` means | Example | Reads |\n| --- | --- | --- | --- | --- |\n"
        ));
        for spec in QUERY_KEYWORDS.iter().filter(|s| s.section == section) {
            let keywords: Vec<String> = spec.keywords.iter().map(|k| format!("`{k}`")).collect();
            let signs: Vec<String> = spec
                .ops
                .iter()
                .map(|op| format!("`{}`", sign_of(*op)))
                .collect();
            out.push_str(&format!(
                "| {} | {} | {} | `{}` | {} |\n",
                keywords.join(" "),
                signs.join(" "),
                colon_means(spec),
                spec.example,
                spec.blurb
            ));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::testing::state;
    use crate::mcp::tools::{call, Called};

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

    /// A paper printing with the columns the syntax below reads.
    fn card(
        c: &rusqlite::Connection,
        id: &str,
        oracle: &str,
        name: &str,
        type_line: &str,
        cmc: f64,
    ) {
        grimoire_core::schema::fixtures::seed_card(c, id, "lea", "1");
        c.execute(
            "UPDATE cards SET name = ?2, oracle_id = ?3, type_line = ?4, type_mask = ?5, cmc = ?6,
                is_paper = 1, legal_mask = 1, search_text = ?2
             WHERE id = ?1",
            rusqlite::params![
                id,
                name,
                oracle,
                type_line,
                grimoire_core::cardtypes::type_mask(type_line),
                cmc
            ],
        )
        .unwrap();
    }

    /// An oracle tag held directly by `holders` (oracle ids).
    fn tag(c: &rusqlite::Connection, slug: &str, holders: &[&str]) {
        c.execute(
            "INSERT OR IGNORE INTO oracle_tags (slug, id, label, description, slug_norm)
             VALUES (?1, ?2, ?1, 'About it.', ?3)",
            rusqlite::params![slug, format!("id-{slug}"), slug.replace('-', "")],
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

    /// Three cards: a goblin, an elf and an instant, the goblin and the instant tagged `burn`.
    fn cards(c: &rusqlite::Connection) {
        card(
            c,
            "s-goblin",
            "o-goblin",
            "Goblin Guide",
            "Creature - Goblin Scout",
            1.0,
        );
        card(
            c,
            "s-elf",
            "o-elf",
            "Llanowar Elves",
            "Creature - Elf Druid",
            1.0,
        );
        card(c, "s-bolt", "o-bolt", "Lightning Bolt", "Instant", 1.0);
        card(
            c,
            "s-giant",
            "o-giant",
            "Hill Giant",
            "Creature - Giant",
            4.0,
        );
        tag(c, "burn", &["o-goblin", "o-bolt"]);
        tag(c, "mana-dork", &["o-elf"]);
        c.execute_batch("INSERT INTO cards_fts(cards_fts) VALUES('rebuild');")
            .unwrap();
    }

    fn names(found: &Value, list: &str) -> Vec<String> {
        let mut names: Vec<String> = found[list]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["name"].as_str().unwrap().to_owned())
            .collect();
        names.sort();
        names
    }

    async fn find(state: &Arc<AppState>, args: Value) -> Vec<String> {
        names(&done(state, "find_cards", args).await, "cards")
    }

    #[tokio::test]
    async fn find_cards_takes_terms_groups_negation_and_exact_names() {
        let state = state("syntax-find");
        seed(&state, cards);
        let s = |syntax: &str| json!({ "syntax": syntax });
        assert_eq!(find(&state, s("t:goblin")).await, ["Goblin Guide"]);
        assert_eq!(
            find(&state, s("t:goblin or t:elf")).await,
            ["Goblin Guide", "Llanowar Elves"]
        );
        assert_eq!(
            find(&state, s("t:creature -(t:goblin or t:elf)")).await,
            ["Hill Giant"]
        );
        assert_eq!(find(&state, s("cmc>=3")).await, ["Hill Giant"]);
        assert_eq!(
            find(&state, s("!\"lightning bolt\"")).await,
            ["Lightning Bolt"]
        );
        assert_eq!(
            find(&state, s("t:creature -goblin")).await,
            ["Hill Giant", "Llanowar Elves"]
        );
        // Beside the tool's other arguments, everything ANDed.
        assert_eq!(
            find(&state, json!({ "query": "hill", "syntax": "t:creature" })).await,
            ["Hill Giant"]
        );
        assert_eq!(
            find(
                &state,
                json!({ "syntax": "t:creature", "filters": { "manaValues": [1] } })
            )
            .await,
            ["Goblin Guide", "Llanowar Elves"]
        );
    }

    #[tokio::test]
    async fn a_tag_resolves_merges_with_the_filter_and_works_inside_an_or() {
        let state = state("syntax-tags");
        seed(&state, cards);
        let s = |syntax: &str| json!({ "syntax": syntax });
        assert_eq!(
            find(&state, s("otag:burn")).await,
            ["Goblin Guide", "Lightning Bolt"]
        );
        // Spelled as a reader types it: the resolver normalises.
        assert_eq!(
            find(&state, s("otag:\"mana dork\"")).await,
            ["Llanowar Elves"]
        );
        assert_eq!(
            find(&state, s("-otag:burn t:creature")).await,
            ["Hill Giant", "Llanowar Elves"]
        );
        // A union with filters.oracleTags: both must hold.
        assert_eq!(
            find(
                &state,
                json!({ "syntax": "otag:burn", "filters": { "oracleTags": ["burn"] } })
            )
            .await,
            ["Goblin Guide", "Lightning Bolt"]
        );
        assert_eq!(
            find(&state, s("otag:burn or t:giant")).await,
            ["Goblin Guide", "Hill Giant", "Lightning Bolt"]
        );
    }

    #[tokio::test]
    async fn an_unknown_tag_is_refused_with_its_closest_names_inside_an_or_too() {
        let state = state("syntax-unknown-tag");
        seed(&state, cards);
        let why = refused(&state, "find_cards", json!({ "syntax": "otag:bur" })).await;
        assert!(
            why.contains("There is no oracle tag called \"bur\"; the closest are \"burn\""),
            "{why}"
        );
        assert!(why.contains("find_tags"), "{why}");
        let why = refused(
            &state,
            "find_cards",
            json!({ "syntax": "t:giant or otag:nothing-like-it" }),
        )
        .await;
        assert!(
            why.contains("There is no oracle tag called \"nothing-like-it\"."),
            "{why}"
        );
    }

    #[tokio::test]
    async fn every_unreadable_term_is_refused_in_one_answer() {
        let state = state("syntax-unread");
        seed(&state, cards);
        let why = refused(
            &state,
            "find_cards",
            json!({ "syntax": "cmc>=banana t: order:usd" }),
        )
        .await;
        assert!(
            why.starts_with("syntax cannot be applied as written. "),
            "{why}"
        );
        for part in ["`cmc>=banana`", "`t:` has no value", "`order:usd`"] {
            assert!(why.contains(part), "{part} is not named: {why}");
        }
    }

    #[tokio::test]
    async fn a_search_needs_a_query_a_syntax_or_a_filter() {
        let state = state("syntax-needs");
        let why = refused(&state, "find_cards", json!({})).await;
        assert!(why.contains("syntax"), "{why}");
    }

    #[tokio::test]
    async fn the_collection_and_the_wishlist_take_syntax() {
        let state = state("syntax-lists");
        seed(&state, |c| {
            cards(c);
            for id in ["s-goblin", "s-elf", "s-bolt"] {
                grimoire_core::schema::fixtures::entry(c, id, 1);
            }
            for id in ["s-giant", "s-elf"] {
                c.execute(
                    "INSERT INTO wishlist_entries
                        (oracle_id, card_id, set_code, collector_number, lang, name, quantity,
                         created_at, updated_at)
                     SELECT oracle_id, id, set_code, collector_number, lang, name, 1,
                            unixepoch(), unixepoch()
                     FROM cards WHERE id = ?1",
                    [id],
                )
                .unwrap();
            }
        });
        let owned = done(
            &state,
            "search_collection",
            json!({ "syntax": "t:creature otag:burn" }),
        )
        .await;
        assert_eq!(names(&owned, "entries"), ["Goblin Guide"]);
        let owned = done(
            &state,
            "search_collection",
            json!({ "syntax": "-t:creature" }),
        )
        .await;
        assert_eq!(names(&owned, "entries"), ["Lightning Bolt"]);
        let wished = done(
            &state,
            "search_wishlist",
            json!({ "syntax": "t:elf or cmc>=4" }),
        )
        .await;
        assert_eq!(names(&wished, "wishes"), ["Hill Giant", "Llanowar Elves"]);
        let wished = done(
            &state,
            "search_wishlist",
            json!({ "syntax": "-otag:mana-dork" }),
        )
        .await;
        assert_eq!(names(&wished, "wishes"), ["Hill Giant"]);
    }

    #[test]
    fn the_reference_names_every_keyword_of_the_table() {
        let reference = keyword_reference();
        for spec in &QUERY_KEYWORDS {
            for keyword in spec.keywords {
                assert!(reference.contains(&format!("`{keyword}`")), "{keyword}");
            }
            assert!(reference.contains(&format!("`{}`", spec.example)));
            assert!(!colon_means(spec).is_empty(), "{}", spec.example);
        }
        for section in QUERY_SECTIONS {
            assert!(reference.contains(&format!("### {section}\n")), "{section}");
        }
    }
}
