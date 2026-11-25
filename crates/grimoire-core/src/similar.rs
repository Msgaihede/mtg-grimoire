//! **Cards that do what a card does**, ranked by the oracle tags they share with it.
//!
//! Direct taggings only (`oracle_taggings`, as the file gave them: no closure, so a parent tag
//! nobody applied does not make two cards look alike). A shared tag counts for its inverse
//! frequency, `ln(N / df)` — `N` the number of tagged cards and `df` the number holding the
//! tag — so a tag thousands of cards hold counts for little and a rare one for a lot. A card's
//! score is the sum over the tags it shares, rounded to three decimals so two runs agree on a
//! tie and the tie breaks by name.
//!
//! Read-only, no network.

use crate::combos::newest_printing_sql;
use crate::filters::{push_card_filters, CardFilters, Predicates};
use rusqlite::{params_from_iter, Connection};
use serde::Serialize;
use std::collections::HashMap;

/// The most cards one answer holds.
const MAX_LIMIT: i64 = 50;
/// How many of the shared tags an answer names.
const NAMED_TAGS: usize = 3;

/// One card like the asked-for one, drawn as its newest printing.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SimilarCard {
    pub name: String,
    pub card_id: String,
    pub oracle_id: String,
    pub type_line: Option<String>,
    pub mana_cost: Option<String>,
    pub score: f64,
    /// The labels of the three shared tags that weigh most (the rarest), heaviest first.
    pub shared_tags: Vec<String>,
}

/// The cards sharing the most, and the rarest, direct tags with `oracle_id`; the card itself is
/// never in its own answer. `limit` is clamped to `1..=50`.
///
/// `format` (a legality key) and `identity` (colour letters, `"C"` for colourless, blank for
/// neither) narrow the candidates the way every card filter does, with the one reading a
/// suggestion wants: a candidate must have **a paper printing** that fits both, which keeps
/// digital-only cards out. The printing drawn for the row is the newest one regardless.
pub fn similar_cards(
    conn: &Connection,
    oracle_id: &str,
    format: Option<&str>,
    identity: Option<&str>,
    limit: i64,
) -> Result<Vec<SimilarCard>, String> {
    let limit = limit.clamp(1, MAX_LIMIT);
    let fail = |e: rusqlite::Error| format!("could not look for similar cards: {e}");

    // The card's own tags, with labels, and N.
    let mut mine: Vec<(String, String)> = conn
        .prepare_cached(
            "SELECT g.slug, t.label FROM oracle_taggings g
               JOIN oracle_tags t ON t.slug = g.slug
              WHERE g.oracle_id = ?1",
        )
        .and_then(|mut s| {
            s.query_map([oracle_id], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect()
        })
        .map_err(fail)?;
    if mine.is_empty() {
        return Ok(Vec::new());
    }
    mine.sort();
    let tagged: i64 = conn
        .query_row(
            "SELECT count(DISTINCT oracle_id) FROM oracle_taggings",
            [],
            |r| r.get(0),
        )
        .map_err(fail)?;

    // df per slug of the card's, then the weight ln(N / df) of each.
    let holes = vec!["?"; mine.len()].join(",");
    let mut weights: HashMap<String, f64> = HashMap::new();
    {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT slug, count(*) FROM oracle_taggings WHERE slug IN ({holes}) GROUP BY slug"
            ))
            .map_err(fail)?;
        let rows = stmt
            .query_map(params_from_iter(mine.iter().map(|(s, _)| s)), |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
            })
            .map_err(fail)?;
        for row in rows {
            let (slug, df) = row.map_err(fail)?;
            weights.insert(slug, (tagged as f64 / df as f64).ln());
        }
    }

    // Candidates: the weights as a CTE, summed per other oracle id, then filtered by an EXISTS
    // over the candidate's printings and drawn as the newest one.
    let mut filters = Predicates::default();
    push_card_filters(
        &mut filters,
        &CardFilters {
            format: format.map(str::to_owned),
            colors: identity.map(str::to_owned),
            ..Default::default()
        },
        "d",
        None,
    );
    let values = vec!["(?,?)"; weights.len()].join(",");
    let sql = format!(
        "WITH w(slug, w) AS (VALUES {values})
         SELECT p.id, p.oracle_id, p.name, p.type_line, p.mana_cost, s.score
           FROM (SELECT c.oid, c.score, c.nm
                   FROM (SELECT g.oracle_id AS oid, round(sum(w.w), 3) AS score,
                                (SELECT x.name FROM cards x WHERE x.oracle_id = g.oracle_id
                                  LIMIT 1) AS nm
                           FROM oracle_taggings g JOIN w ON w.slug = g.slug
                          WHERE g.oracle_id <> ?
                          GROUP BY g.oracle_id) c
                  WHERE EXISTS (SELECT 1 FROM cards d WHERE d.oracle_id = c.oid AND {filters})
                  ORDER BY c.score DESC, c.nm, c.oid
                  LIMIT ?) s
           JOIN cards p ON p.id = {printing}
          ORDER BY s.score DESC, s.nm, s.oid",
        printing = newest_printing_sql("s.oid"),
        filters = filters.where_sql(),
    );
    let mut binds: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    for (slug, w) in &weights {
        binds.push(Box::new(slug.clone()));
        binds.push(Box::new(*w));
    }
    binds.push(Box::new(oracle_id.to_owned()));
    binds.append(&mut filters.params);
    binds.push(Box::new(limit));
    let mut stmt = conn.prepare(&sql).map_err(fail)?;
    let mut out: Vec<SimilarCard> = stmt
        .query_map(params_from_iter(binds.iter().map(|b| b.as_ref())), |r| {
            Ok(SimilarCard {
                card_id: r.get(0)?,
                oracle_id: r.get(1)?,
                name: r.get(2)?,
                type_line: r.get(3)?,
                mana_cost: r.get(4)?,
                score: r.get(5)?,
                shared_tags: Vec::new(),
            })
        })
        .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
        .map_err(fail)?;

    // What each answer shares, heaviest (rarest) first, ties by label.
    let mut own = conn
        .prepare("SELECT slug FROM oracle_taggings WHERE oracle_id = ?")
        .map_err(fail)?;
    for card in &mut out {
        let held: Vec<String> = own
            .query_map([&card.oracle_id], |r| r.get(0))
            .and_then(|rows| rows.collect())
            .map_err(fail)?;
        let mut shared: Vec<(f64, &str)> = mine
            .iter()
            .filter(|(s, _)| held.contains(s))
            .map(|(s, label)| (weights.get(s).copied().unwrap_or(0.0), label.as_str()))
            .collect();
        shared.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(b.1)));
        card.shared_tags = shared
            .into_iter()
            .take(NAMED_TAGS)
            .map(|(_, l)| l.to_owned())
            .collect();
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    /// A printing with the columns a suggestion reads.
    fn card(conn: &Connection, id: &str, oracle: &str, name: &str, identity: &str, legal: bool) {
        conn.execute(
            "INSERT INTO cards (id, oracle_id, name, set_code, collector_number, lang, layout,
                                released_at, type_line, mana_cost, color_identity, legal_mask, raw)
             VALUES (?1, ?2, ?3, 'tst', ?1, 'en', 'normal', '2020-01-01', 'Artifact', '{2}',
                     ?4, ?5, '{}')",
            params![
                id,
                oracle,
                name,
                identity,
                if legal {
                    crate::legalities::bit("commander").unwrap() as i64
                } else {
                    0
                }
            ],
        )
        .unwrap();
    }

    /// `(oracle id, name)` cards and `(oracle id, slug)` taggings; every slug's label is the slug
    /// upper-cased.
    fn corpus(cards: &[(&str, &str)], taggings: &[(&str, &str)]) -> Connection {
        let conn = crate::schema::memory_pair();
        for (oracle, name) in cards {
            card(&conn, &format!("p-{oracle}"), oracle, name, "", true);
        }
        for (oracle, slug) in taggings {
            conn.execute(
                "INSERT OR IGNORE INTO oracle_tags (slug, label) VALUES (?1, ?2)",
                params![slug, slug.to_uppercase()],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO oracle_taggings (oracle_id, slug) VALUES (?1, ?2)",
                params![oracle, slug],
            )
            .unwrap();
        }
        conn
    }

    fn names(rows: &[SimilarCard]) -> Vec<&str> {
        rows.iter().map(|r| r.name.as_str()).collect()
    }

    #[test]
    fn a_rare_shared_tag_outweighs_a_common_one() {
        // `rare` is held by A and B; `common` by A, C, D and E.
        let conn = corpus(
            &[("a", "A"), ("b", "B"), ("c", "C"), ("d", "D"), ("e", "E")],
            &[
                ("a", "rare"),
                ("b", "rare"),
                ("a", "common"),
                ("c", "common"),
                ("d", "common"),
                ("e", "common"),
            ],
        );
        let rows = similar_cards(&conn, "a", None, None, 10).unwrap();
        assert_eq!(names(&rows)[..2], ["B", "C"]);
        assert!(rows[0].score > rows[1].score);
    }

    #[test]
    fn score_is_the_sum_of_ln_n_over_df() {
        // N = 4 tagged cards. `x`: A, B (df 2). `y`: A, B, C (df 3). D carries `z` only.
        let conn = corpus(
            &[("a", "A"), ("b", "B"), ("c", "C"), ("d", "D")],
            &[
                ("a", "x"),
                ("b", "x"),
                ("a", "y"),
                ("b", "y"),
                ("c", "y"),
                ("d", "z"),
            ],
        );
        let rows = similar_cards(&conn, "a", None, None, 10).unwrap();
        // ln(4/2) + ln(4/3) = 0.6931 + 0.2877 = 0.9808; ln(4/3) = 0.2877.
        assert_eq!(
            rows.iter()
                .map(|r| (r.name.as_str(), r.score))
                .collect::<Vec<_>>(),
            vec![("B", 0.981), ("C", 0.288)]
        );
    }

    #[test]
    fn the_card_itself_is_never_similar_to_itself() {
        let conn = corpus(
            &[("a", "A"), ("b", "B")],
            &[("a", "x"), ("b", "x"), ("a", "y")],
        );
        let rows = similar_cards(&conn, "a", None, None, 10).unwrap();
        assert_eq!(names(&rows), ["B"]);
    }

    #[test]
    fn ties_are_broken_by_name() {
        let conn = corpus(
            &[("a", "A"), ("z", "Zed"), ("m", "Mid"), ("k", "Kit")],
            &[("a", "x"), ("z", "x"), ("m", "x"), ("k", "x")],
        );
        let rows = similar_cards(&conn, "a", None, None, 10).unwrap();
        assert_eq!(names(&rows), ["Kit", "Mid", "Zed"]);
    }

    #[test]
    fn format_and_identity_narrow_the_candidates() {
        let conn = corpus(
            &[("a", "A")],
            &[("a", "x"), ("b", "x"), ("c", "x"), ("d", "x")],
        );
        card(&conn, "p-b", "b", "Blue", "U", true);
        card(&conn, "p-c", "c", "Banned", "", false);
        card(&conn, "p-d", "d", "Clear", "", true);
        let all = similar_cards(&conn, "a", None, None, 10).unwrap();
        assert_eq!(names(&all), ["Banned", "Blue", "Clear"]);
        let legal = similar_cards(&conn, "a", Some("commander"), None, 10).unwrap();
        assert_eq!(names(&legal), ["Blue", "Clear"]);
        let colourless = similar_cards(&conn, "a", None, Some("C"), 10).unwrap();
        assert_eq!(names(&colourless), ["Banned", "Clear"]);
        let blue = similar_cards(&conn, "a", Some("commander"), Some("U"), 10).unwrap();
        assert_eq!(names(&blue), ["Blue", "Clear"]);
        let blank = similar_cards(&conn, "a", None, Some(""), 10).unwrap();
        assert_eq!(blank.len(), 3, "a blank identity is no filter");
    }

    #[test]
    fn a_card_with_only_a_digital_printing_is_not_suggested() {
        let conn = corpus(&[("a", "A"), ("b", "B")], &[("a", "x"), ("b", "x")]);
        conn.execute("UPDATE cards SET is_paper = 0 WHERE oracle_id = 'b'", [])
            .unwrap();
        assert!(similar_cards(&conn, "a", None, None, 10)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn a_candidate_is_drawn_as_its_newest_printing() {
        let conn = corpus(&[("a", "A"), ("b", "B")], &[("a", "x"), ("b", "x")]);
        card(&conn, "p-b-new", "b", "B", "", true);
        conn.execute(
            "UPDATE cards SET released_at = '2024-01-01' WHERE id = 'p-b-new'",
            [],
        )
        .unwrap();
        let rows = similar_cards(&conn, "a", None, None, 10).unwrap();
        assert_eq!(rows[0].card_id, "p-b-new");
        assert_eq!(rows[0].oracle_id, "b");
        assert_eq!(rows[0].type_line.as_deref(), Some("Artifact"));
        assert_eq!(rows[0].mana_cost.as_deref(), Some("{2}"));
    }

    #[test]
    fn shared_tags_are_the_three_highest_weighted_labels() {
        // B shares four tags with A; their rarity runs w < x < y < z, so the answer names
        // z, y and x. Cards C..F pad the frequencies.
        let conn = corpus(
            &[
                ("a", "A"),
                ("b", "B"),
                ("c", "C"),
                ("d", "D"),
                ("e", "E"),
                ("f", "F"),
            ],
            &[
                ("a", "w"),
                ("b", "w"),
                ("c", "w"),
                ("d", "w"),
                ("e", "w"),
                ("a", "x"),
                ("b", "x"),
                ("c", "x"),
                ("d", "x"),
                ("a", "y"),
                ("b", "y"),
                ("c", "y"),
                ("a", "z"),
                ("b", "z"),
                ("f", "q"),
            ],
        );
        let rows = similar_cards(&conn, "a", None, None, 1).unwrap();
        assert_eq!(rows[0].name, "B");
        assert_eq!(rows[0].shared_tags, ["Z", "Y", "X"]);
    }

    #[test]
    fn an_untagged_card_has_no_similar_cards() {
        let conn = corpus(&[("a", "A"), ("b", "B")], &[("b", "x")]);
        assert!(similar_cards(&conn, "a", None, None, 10)
            .unwrap()
            .is_empty());
        assert!(similar_cards(&conn, "nobody", None, None, 10)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn the_limit_is_clamped_to_one_through_fifty() {
        let cards: Vec<(String, String)> = (0..60)
            .map(|i| (format!("o{i:02}"), format!("Card {i:02}")))
            .collect();
        let refs: Vec<(&str, &str)> = cards
            .iter()
            .map(|(o, n)| (o.as_str(), n.as_str()))
            .collect();
        let tags: Vec<(&str, &str)> = cards.iter().map(|(o, _)| (o.as_str(), "x")).collect();
        let conn = corpus(&refs, &tags);
        assert_eq!(
            similar_cards(&conn, "o00", None, None, 500).unwrap().len(),
            50
        );
        assert_eq!(similar_cards(&conn, "o00", None, None, 0).unwrap().len(), 1);
        assert_eq!(
            similar_cards(&conn, "o00", None, None, -3).unwrap().len(),
            1
        );
    }
}
