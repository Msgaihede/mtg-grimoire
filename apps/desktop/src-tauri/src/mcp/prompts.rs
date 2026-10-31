//! **The skills the server ships**, as MCP prompts (`prompts/list`, `prompts/get`): how to search
//! cards, how to create a custom home widget, and how to find one's way around the read graph.
//!
//! **Prompts rather than files a reader installs** (the owner's decision, 2026-10-31): every MCP
//! client can ask for them, Claude Desktop's bundle included, and they update with the app. Each
//! is a Markdown file beside this one (`prompts/*.md`), compiled in, so it reads as prose in review;
//! `create_widget` closes with the widget catalogue's committed prompt (`tools::CATALOG_PROMPT`).
//!
//! **The examples are held to the graph**: every fenced `graphql` block in the three files must pass
//! `Graph::validate` (`every_example_query_is_valid`), so a renamed field fails here rather than
//! in an agent's hands.

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

const PROMPTS: [Prompt; 3] = [
    Prompt {
        name: "search_cards",
        title: "Search cards",
        description: "How to find cards in the whole card database, the user's collection and their \
            wishlist — by name with the search tools, and by type, colour, mana value, tags, rarity \
            or price through the read graph's structured filters.",
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
        description: "A map of the read graph's root fields, how its schema reads (nullability, ids, \
            money, timestamps, filters, depth) and how to find, check and run a query.",
        argument: ("question", "What the user wants to know from their data."),
        body: include_str!("prompts/graphql_discovery.md"),
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

/// `prompts/get`'s answer for `name` with `arguments`, or `None` for a name that is no prompt.
pub fn get(name: &str, arguments: Option<&Value>) -> Option<Value> {
    let prompt = PROMPTS.iter().find(|p| p.name == name)?;
    let mut text = prompt.body.trim_end().to_owned();
    if prompt.name == "create_widget" {
        text.push_str("\n\n");
        text.push_str(CATALOG_PROMPT.trim_end());
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
    fn the_three_skills_are_listed_each_with_one_optional_argument() {
        let names: Vec<String> = list()
            .iter()
            .map(|p| p["name"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(
            names,
            ["search_cards", "create_widget", "graphql_discovery"]
        );
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
        assert!(get("add_cards", None).is_none());
    }

    #[test]
    fn no_skill_offers_a_tool_that_writes_the_user_s_cards() {
        for prompt in &PROMPTS {
            for gone in ["add_to_collection", "add_to_wishlist", "add_card_to_deck"] {
                assert!(!prompt.body.contains(gone), "{} names {gone}", prompt.name);
            }
        }
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
