//! Entry tags: every entry tag in use — the reader's free-text tags on collection entries and
//! wishes, counted across both.
//!
//! An entry tag is not a Scryfall tag (`crate::tags`), a deck label or a deck tag
//! (`docs/agent/DOMAIN_VOCABULARY.md`). A row's own entry tags are its `entryTags` field, in
//! `crate::collection` and `crate::wishlist`.
//!
//! **The core answers per exact spelling** (`entry_tags::entry_tags_in_use`); folding the capitals
//! into the suggestion a reader sees is the page's rule (`features/entryTags/entryTags.ts`'
//! `entryTagsInUse`), small and mechanical enough to repeat here ([`fold`]) so the default answer
//! is the page's. Its alphabetical order is `Intl.Collator("en", { sensitivity: "base", numeric:
//! true })`, which [`compare_labels`] follows for case, digits and punctuation — but not for
//! accents: an accented letter sorts by its code point, after `z`.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::sync::Arc;

use async_graphql::{Context, Object, Request, Result};
use grimoire_core::entry_tags::{entry_tags_in_use, EntryTagUse as CoreUse};
use grimoire_core::state::State;

use crate::{invalidatedBy, read, roots};

/// One entry tag and how many collection entries and wishes wear it.
pub struct EntryTagUse(pub CoreUse);

#[Object(rename_fields = "camelCase")]
impl EntryTagUse {
    async fn tag(&self) -> &str {
        &self.0.tag
    }
    /// Collection entries and wishes, summed.
    async fn count(&self) -> i64 {
        self.0.count
    }
}

/// Spellings differing only in capitals folded into one row, counted together and named by the
/// spelling more stacks use — a tie to the one first in byte order — alphabetical by
/// [`compare_labels`]. The page's `entryTagsInUse`, with `tagKey` (lower case) as the fold.
fn fold(rows: Vec<CoreUse>) -> Vec<CoreUse> {
    // Key → (total, spellings in first-seen order with their counts).
    let mut by_key: HashMap<String, (i64, Vec<(String, i64)>)> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    for CoreUse { tag, count } in rows {
        let key = tag.to_lowercase();
        let found = by_key.entry(key.clone()).or_insert_with(|| {
            order.push(key);
            (0, Vec::new())
        });
        found.0 += count;
        match found.1.iter_mut().find(|(s, _)| *s == tag) {
            Some((_, uses)) => *uses += count,
            None => found.1.push((tag, count)),
        }
    }
    let mut folded: Vec<CoreUse> = order
        .into_iter()
        .filter_map(|key| by_key.remove(&key))
        .map(|(count, mut spellings)| {
            spellings.sort_by(|(a, uses), (b, others)| others.cmp(uses).then_with(|| a.cmp(b)));
            let tag = spellings.swap_remove(0).0;
            CoreUse { tag, count }
        })
        .collect();
    folded.sort_by(|a, b| compare_labels(&a.tag, &b.tag).then_with(|| a.tag.cmp(&b.tag)));
    folded
}

/// One piece of a label as the collator weighs it: a run of digits, by its number, or one
/// character, by its class and then its lower case.
#[derive(PartialEq, Eq, PartialOrd, Ord)]
enum Piece<'a> {
    /// Spaces, punctuation and symbols — before digits, as the collator puts them.
    Mark(char),
    /// A run of ASCII digits without its leading zeros: shorter is smaller, then digit by digit.
    Number(usize, &'a str),
    /// Letters and everything else.
    Letter(char),
}

fn pieces(label: &str) -> Vec<Piece<'_>> {
    let mut out = Vec::new();
    let mut rest = label;
    while let Some(c) = rest.chars().next() {
        if c.is_ascii_digit() {
            let end = rest
                .find(|d: char| !d.is_ascii_digit())
                .unwrap_or(rest.len());
            let digits = rest[..end].trim_start_matches('0');
            out.push(Piece::Number(digits.len(), digits));
            rest = &rest[end..];
        } else {
            let lower = c.to_lowercase().next().unwrap_or(c);
            out.push(if c.is_alphanumeric() {
                Piece::Letter(lower)
            } else {
                Piece::Mark(lower)
            });
            rest = &rest[c.len_utf8()..];
        }
    }
    out
}

/// Two labels alphabetically, as the page's `compareLabels` orders them: capitals ignored, digit
/// runs by their number (`Set 2` before `Set 10`), spaces and punctuation before digits before
/// letters. Equal for two spellings of one word.
fn compare_labels(a: &str, b: &str) -> Ordering {
    pieces(a).cmp(&pieces(b))
}

/// This domain's batch loaders, for one execution — none: its one root field reads once.
pub(crate) fn data(request: Request, _state: &Arc<State>) -> Request {
    request
}

#[derive(Default)]
pub struct EntryTagsQuery;

#[Object(rename_fields = "camelCase")]
impl EntryTagsQuery {
    /// Every entry tag the reader has put on a collection entry or a wish, with how many wear it —
    /// alphabetical. Not Scryfall tags, deck labels or deck tags.
    // Its own root, and the two lists' too: removing a stack or a wish moves a count.
    #[graphql(directive = invalidatedBy::apply(roots(&["entryTags", "collection", "wishlist"])))]
    async fn entry_tags_in_use(
        &self,
        ctx: &Context<'_>,
        #[graphql(
            desc = "`true`: one row per exact spelling (`Cube` and `cube` apart), sorted by byte order. Default `false`: spellings differing only in capitals folded into one row, named by the spelling more stacks use — what the app's tag field suggests."
        )]
        exact_spelling: Option<bool>,
    ) -> Result<Option<Vec<EntryTagUse>>> {
        let rows = read(ctx, entry_tags_in_use)?;
        let rows = if exact_spelling.unwrap_or(false) {
            rows
        } else {
            fold(rows)
        };
        Ok(Some(rows.into_iter().map(EntryTagUse).collect()))
    }
}

#[cfg(test)]
mod tests {
    use std::cmp::Ordering;

    use grimoire_core::collection::{add_entry, EntryInput};
    use grimoire_core::entry_tags::{set_collection_tags, set_wish_tags, EntryTagUse as CoreUse};
    use grimoire_core::schema::fixtures::seed_card;
    use grimoire_core::state::fixtures::on_files;
    use grimoire_core::wishlist::{add_wish, WishInput};
    use serde_json::json;

    use super::{compare_labels, fold};
    use crate::Graph;

    fn uses(rows: &[(&str, i64)]) -> Vec<CoreUse> {
        rows.iter()
            .map(|(tag, count)| CoreUse {
                tag: (*tag).to_owned(),
                count: *count,
            })
            .collect()
    }

    /// The page's `entryTagsInUse`: capitals folded, counts summed, the spelling more stacks use
    /// named (a tie to the first in byte order), alphabetical with digit runs by their number.
    #[test]
    fn spellings_fold_into_one_suggestion() {
        // In the core's byte order, as `entry_tags_in_use` answers.
        let rows = uses(&[
            ("Cube", 3),
            ("RAMP", 2),
            ("Ramp", 2),
            ("Set 10", 1),
            ("cube", 1),
            ("set 2", 1),
        ]);
        let folded: Vec<(String, i64)> = fold(rows).into_iter().map(|u| (u.tag, u.count)).collect();
        assert_eq!(
            folded,
            vec![
                ("Cube".to_owned(), 4),
                ("RAMP".to_owned(), 4),
                ("set 2".to_owned(), 1),
                ("Set 10".to_owned(), 1),
            ]
        );
    }

    #[test]
    fn labels_compare_as_the_page_s_collator_does() {
        assert_eq!(compare_labels("cube", "Cube"), Ordering::Equal);
        assert_eq!(compare_labels("Set 2", "set 10"), Ordering::Less);
        assert_eq!(compare_labels("a-b", "a1"), Ordering::Less);
        assert_eq!(compare_labels("a1", "ab"), Ordering::Less);
        assert_eq!(compare_labels("x 007", "x 7"), Ordering::Equal);
        assert_eq!(compare_labels("ab", "abc"), Ordering::Less);
    }

    #[test]
    fn entry_tags_in_use_answers_folded_and_by_exact_spelling() {
        let state = on_files("graph-entry-tags", "http://127.0.0.1:1").0;
        {
            let conn = state.lock_db();
            seed_card(&conn, "bolt-a", "lea", "1");
            seed_card(&conn, "bolt-b", "m10", "2");
            for (card, tags) in [
                ("bolt-a", ["Cube", "Trade"]),
                ("bolt-b", ["cube", "Binder"]),
            ] {
                let entry = EntryInput {
                    card_id: card.into(),
                    finish: "nonfoil".into(),
                    quantity: 1,
                    ..EntryInput::default()
                };
                let id = add_entry(&conn, &entry).unwrap().id;
                set_collection_tags(&conn, id, &tags.map(String::from)).unwrap();
            }
            let wish = WishInput {
                card_id: Some("bolt-a".into()),
                quantity: 1,
                ..WishInput::default()
            };
            let id = add_wish(&conn, &wish).unwrap().id;
            set_wish_tags(&conn, id, &["Cube".into()]).unwrap();
        }
        let response = Graph::new().run(
            &state,
            "{ folded: entryTagsInUse { tag count } exact: entryTagsInUse(exactSpelling: true) { tag count } }",
            None,
            None,
            None,
        );
        assert!(response.errors.is_empty(), "{:?}", response.errors);
        let data = response.data.into_json().unwrap();
        assert_eq!(
            data["folded"],
            json!([
                { "tag": "Binder", "count": 1 },
                { "tag": "Cube", "count": 3 },
                { "tag": "Trade", "count": 1 },
            ])
        );
        assert_eq!(
            data["exact"],
            json!([
                { "tag": "Binder", "count": 1 },
                { "tag": "Cube", "count": 2 },
                { "tag": "Trade", "count": 1 },
                { "tag": "cube", "count": 1 },
            ])
        );
    }
}
