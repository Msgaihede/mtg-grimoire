//! **The skills the server ships**, as MCP prompts (`prompts/list`, `prompts/get`): how to search
//! cards, how to create a custom home widget, how to find one's way around the read graph, how
//! cards fit together (what a card does, its combos, tags and related cards, a format's rules), and
//! how to write a search in Scryfall's syntax.
//!
//! **Prompts rather than files a reader installs** (the owner's decision, 2026-10-31): every MCP
//! client can ask for them, Claude Desktop's bundle included, and they update with the app. Each
//! is a Markdown file beside this one (`prompts/*.md`), compiled in, so it reads as prose in review;
//! `create_widget` closes with the widget catalogue's committed prompt (`tools::CATALOG_PROMPT`) and
//! `scryfall_syntax` with the keyword reference generated from the parser's own table
//! (`syntax::keyword_reference`), so neither can name what the server does not take.
//!
//! **Every prompt is also the agent's to read** (spec §2): most clients run a prompt only when the
//! user picks it, so the tool `read_guide` answers the same text, its topics being [`names`].
//!
//! **The examples are held to the graph and to the parser**: every fenced `graphql` block in the
//! files must pass `Graph::validate` (`every_example_query_is_valid`), so a renamed field fails
//! here rather than in an agent's hands; and every example search must read as written through
//! `query_language::read` (`every_example_search_reads_as_written`). **An example a reader could
//! copy goes in a fenced `scryfall` block**, one search a line; a search the prose says is refused
//! goes in a `scryfall-refused` block, and must be; a tool call written out goes in a `json`
//! block, and its `syntax` must read.

use super::syntax::keyword_reference;
use super::tools::CATALOG_PROMPT;
use serde_json::{json, Value};

/// One prompt: its name, what a client shows, the one optional argument it takes, and its text.
struct Prompt {
    name: &'static str,
    title: &'static str,
    description: &'static str,
    argument: (&'static str, &'static str),
    body: &'static str,
}

const PROMPTS: [Prompt; 5] = [
    Prompt {
        name: "search_cards",
        title: "Search cards",
        description:
            "How to find cards in the whole card database, the user's collection and their \
            wishlist — by name with the search tools, by type, colour, mana value, tags, rarity or \
            price through find_cards' filters, and through the read graph's structured filters \
            for the collection and wishlist, art tags and sorting — and how to show a search on \
            the app's Search page with show_search.",
        argument: ("request", "What the user is looking for, in their words."),
        body: include_str!("prompts/search_cards.md"),
    },
    Prompt {
        name: "create_widget",
        title: "Create a custom home widget",
        description: "The steps to build the user a custom home-page widget — a data query and a \
            json-render spec, checked, previewed and stored — and the whole widget catalogue.",
        argument: ("idea", "What the widget should show, in the user's words."),
        body: include_str!("prompts/create_widget.md"),
    },
    Prompt {
        name: "graphql_discovery",
        title: "Explore the data graph",
        description:
            "A map of the read graph's root fields, how its schema reads (nullability, ids, \
            money, timestamps, filters, depth) and how to find, check and run a query.",
        argument: ("question", "What the user wants to know from their data."),
        body: include_str!("prompts/graphql_discovery.md"),
    },
    Prompt {
        name: "card_interactions",
        title: "How cards fit together",
        description: concat!(
            "Which tool answers what a card does, its combos, what it brings with it, cards that ",
            "do the same job, its raw Scryfall facts and a format's rules — and what each source ",
            "can and cannot tell."
        ),
        argument: (
            "question",
            "What the user wants to know about a card or a combo.",
        ),
        body: include_str!("prompts/card_interactions.md"),
    },
    Prompt {
        name: "scryfall_syntax",
        title: "Search with Scryfall syntax",
        description: concat!(
            "How to write a search in Scryfall's syntax for find_cards, search_collection and ",
            "search_wishlist: the grammar, what each keyword means here and where the app differs ",
            "from Scryfall, how a refusal reads, worked examples, and every keyword."
        ),
        argument: (
            "search",
            "The search the user wants, in their words or in Scryfall syntax.",
        ),
        body: include_str!("prompts/scryfall_syntax.md"),
    },
];

/// `prompts/list`'s answer.
pub fn list() -> Vec<Value> {
    PROMPTS
        .iter()
        .map(|p| {
            json!({
                "name": p.name,
                "title": p.title,
                "description": p.description,
                "arguments": [{ "name": p.argument.0, "description": p.argument.1, "required": false }],
            })
        })
        .collect()
}

/// Every prompt's name, in `prompts/list`'s order — the topics `read_guide` takes.
pub fn names() -> Vec<&'static str> {
    PROMPTS.iter().map(|p| p.name).collect()
}

/// `prompts/get`'s answer for `name` with `arguments`, or `None` for a name that is no prompt.
pub fn get(name: &str, arguments: Option<&Value>) -> Option<Value> {
    let prompt = PROMPTS.iter().find(|p| p.name == name)?;
    let mut text = prompt.body.trim_end().to_owned();
    if prompt.name == "create_widget" {
        text.push_str("\n\n");
        text.push_str(CATALOG_PROMPT.trim_end());
    }
    if prompt.name == "scryfall_syntax" {
        text.push_str("\n\n");
        text.push_str(keyword_reference().trim_end());
    }
    let asked = arguments
        .and_then(|a| a.get(prompt.argument.0))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|asked| !asked.is_empty());
    if let Some(asked) = asked {
        text.push_str(&format!("\n\n## The user's request\n\n{asked}"));
    }
    Some(json!({
        "description": prompt.title,
        "messages": [{ "role": "user", "content": { "type": "text", "text": text } }],
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_five_skills_are_listed_each_with_one_optional_argument() {
        let listed: Vec<String> = list()
            .iter()
            .map(|p| p["name"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(
            listed,
            [
                "search_cards",
                "create_widget",
                "graphql_discovery",
                "card_interactions",
                "scryfall_syntax"
            ]
        );
        assert_eq!(names(), listed);
        for prompt in list() {
            assert_eq!(prompt["arguments"].as_array().unwrap().len(), 1);
            assert_eq!(prompt["arguments"][0]["required"], false);
        }
    }

    #[test]
    fn a_prompt_is_its_file_and_the_user_s_request() {
        let text = |name: &str, args: Value| {
            get(name, Some(&args)).unwrap()["messages"][0]["content"]["text"]
                .as_str()
                .unwrap()
                .to_owned()
        };
        let search = text("search_cards", json!({}));
        assert!(search.starts_with("# Searching cards in MTG Grimoire"));
        assert!(!search.contains("The user's request"));
        assert!(
            text("search_cards", json!({ "request": "cheap red creatures" }))
                .ends_with("## The user's request\n\ncheap red creatures")
        );
        // The widget skill closes with the whole catalogue.
        assert!(text("create_widget", json!({})).ends_with(CATALOG_PROMPT.trim_end()));
        assert!(text(
            "card_interactions",
            json!({ "question": "does Thoracle combo?" })
        )
        .ends_with("## The user's request\n\ndoes Thoracle combo?"));
        // The syntax skill closes with the keyword reference, and names the three tools.
        let syntax = text("scryfall_syntax", json!({ "search": "cheap goblins" }));
        assert!(syntax.starts_with("# Searching with Scryfall syntax in MTG Grimoire"));
        assert!(syntax.contains(keyword_reference().trim_end()));
        assert!(syntax.ends_with("## The user's request\n\ncheap goblins"));
        for tool in [
            "find_cards",
            "search_collection",
            "search_wishlist",
            "find_tags",
        ] {
            assert!(
                syntax.contains(&format!("`{tool}`")),
                "scryfall_syntax does not name {tool}"
            );
        }
        assert!(get("add_cards", None).is_none());
    }

    /// The card-knowledge skill routes each question to a tool, so every tool it teaches must be
    /// named in it — and must be a tool the server lists.
    #[test]
    fn card_interactions_names_every_tool_it_teaches() {
        let text = get("card_interactions", None).expect("card_interactions is a prompt")
            ["messages"][0]["content"]["text"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(text.starts_with("# How cards fit together in MTG Grimoire"));
        let tools: Vec<String> = super::super::tools::list()
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_owned())
            .collect();
        for tool in [
            "get_card",
            "card_combos",
            "get_combo",
            "held_combos",
            "find_tags",
            "find_cards",
            "similar_cards",
            "card_scryfall",
            "format_rules",
        ] {
            assert!(
                text.contains(&format!("`{tool}`")),
                "card_interactions does not name {tool}"
            );
            assert!(tools.contains(&tool.to_owned()), "{tool} is not a tool");
        }
    }

    #[test]
    fn no_skill_offers_a_tool_that_writes_the_user_s_cards() {
        for prompt in &PROMPTS {
            for gone in ["add_to_collection", "add_to_wishlist", "add_card_to_deck"] {
                assert!(!prompt.body.contains(gone), "{} names {gone}", prompt.name);
            }
        }
    }

    /// The fenced blocks of one `language` in a prompt's text, each without its fences.
    fn fenced<'a>(body: &'a str, language: &str) -> Vec<&'a str> {
        let open = format!("```{language}\n");
        let mut blocks = Vec::new();
        let mut rest = body;
        while let Some(start) = rest.find(&open) {
            let block = &rest[start + open.len()..];
            let end = block.find("```").expect("a fenced block closes");
            blocks.push(&block[..end]);
            rest = &block[end + 3..];
        }
        blocks
    }

    /// Every search in a tool call written out as JSON: a `syntax` value, and a `text` one
    /// (`show_search`'s box text, which is Scryfall syntax too; `find_tags`' words read as words).
    fn syntax_values(value: &Value, out: &mut Vec<String>) {
        match value {
            Value::Object(map) => {
                for (key, v) in map {
                    match (key.as_str(), v) {
                        ("syntax" | "text", Value::String(s)) => out.push(s.clone()),
                        _ => syntax_values(v, out),
                    }
                }
            }
            Value::Array(list) => list.iter().for_each(|v| syntax_values(v, out)),
            _ => {}
        }
    }

    /// **Every example search reads as written** — through the tools' own door,
    /// `query_language::read`, so an example an agent copies is never refused and never reads as
    /// something other than it says. And every search the prose says is refused, is.
    #[test]
    fn every_example_search_reads_as_written() {
        use grimoire_core::query_language::read;
        let (mut accepted, mut refused, mut calls) = (0, 0, 0);
        for prompt in &PROMPTS {
            let lines = |block: &'static str| {
                block
                    .lines()
                    .map(str::trim)
                    .filter(|line| !line.is_empty())
                    .collect::<Vec<_>>()
            };
            for line in fenced(prompt.body, "scryfall").into_iter().flat_map(lines) {
                let parsed = read(line).unwrap_or_else(|unread| {
                    panic!("{}'s example {line:?} is refused: {unread:?}", prompt.name)
                });
                assert!(
                    !parsed.text.is_empty()
                        || !parsed.tags.is_empty()
                        || !parsed.predicates.is_empty(),
                    "{}'s example {line:?} says nothing",
                    prompt.name
                );
                accepted += 1;
            }
            for line in fenced(prompt.body, "scryfall-refused")
                .into_iter()
                .flat_map(lines)
            {
                assert!(
                    read(line).is_err(),
                    "{}'s refused example {line:?} is read",
                    prompt.name
                );
                refused += 1;
            }
            for block in fenced(prompt.body, "json") {
                if !block.contains("\"syntax\"") && !block.contains("\"text\"") {
                    continue;
                }
                let call: Value = serde_json::from_str(block).unwrap_or_else(|e| {
                    panic!("{}'s tool call is not JSON: {e}\n{block}", prompt.name)
                });
                let mut found = Vec::new();
                syntax_values(&call, &mut found);
                for syntax in found {
                    assert!(
                        read(&syntax).is_ok(),
                        "{}'s tool call's syntax {syntax:?} is refused: {:?}",
                        prompt.name,
                        read(&syntax)
                    );
                    calls += 1;
                }
            }
        }
        assert!(
            accepted >= 20 && refused >= 5 && calls >= 3,
            "the examples were read ({accepted} searches, {refused} refusals, {calls} calls)"
        );
    }

    /// Every fenced `graphql` example is a query the graph accepts.
    #[test]
    fn every_example_query_is_valid() {
        let mut checked = 0;
        for prompt in &PROMPTS {
            let mut rest = prompt.body;
            while let Some(start) = rest.find("```graphql\n") {
                let block = &rest[start + "```graphql\n".len()..];
                let end = block.find("```").expect("a fenced block closes");
                let query = &block[..end];
                let problems = crate::graph::graph().validate(query);
                assert!(
                    problems.is_empty(),
                    "{}'s example does not validate: {problems:?}\n{query}",
                    prompt.name
                );
                checked += 1;
                rest = &block[end + 3..];
            }
        }
        assert!(checked >= 8, "the examples were read ({checked})");
    }
}
