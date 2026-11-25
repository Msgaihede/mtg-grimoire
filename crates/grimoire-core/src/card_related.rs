//! What one card brings with it: the tokens and emblems it makes, its meld partner and result,
//! the cards it is a combo piece with, and the helper cards its rules text plays (the Monarch,
//! the initiative, Day // Night). The MCP server's `get_card` reads it.
//!
//! The walk is [`crate::deck_tokens`]'s — the same keep rules and the same helper markers, read
//! for one card and without the deck. **Self is left out by `oracle_id`, never by name**: an
//! Embalm or Eternalize token wears its maker's name, and a name match would drop it.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;

use crate::deck_tokens::{marker_printings, rules_text, EXTRA_LAYOUTS, MARKERS};

/// One card another card brings with it. `relation` is `token`, `emblem`, `meldPart`,
/// `meldResult`, `comboPiece` or `helper`; `card_id` is `None` for a part the corpus does not
/// hold, which then keeps the name and type line its `all_parts` entry gave.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RelatedCard {
    pub relation: String,
    pub name: String,
    pub card_id: Option<String>,
    pub type_line: Option<String>,
}

fn str_field(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// What card `id` brings with it, in `all_parts` order and then the helpers. An unknown id, a
/// blob that will not parse, or a card with no `all_parts` and no marker answers `[]`.
pub fn related_cards(conn: &Connection, id: &str) -> Result<Vec<RelatedCard>, String> {
    let row: Option<(Option<String>, Option<Vec<u8>>)> = conn
        .query_row(
            "SELECT oracle_id, CAST(raw AS BLOB) FROM cards WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((own_oracle, stored)) = row else {
        return Ok(Vec::new());
    };
    let Some(card) = stored
        .as_deref()
        .and_then(crate::card_row::raw_json)
        .and_then(|json| serde_json::from_str::<Value>(&json).ok())
    else {
        return Ok(Vec::new());
    };

    let mut out = Vec::new();
    // Cards `all_parts` already answered, so a marker never answers one a second time.
    let mut named: Vec<String> = Vec::new();
    let mut resolve = conn
        .prepare("SELECT layout, oracle_id, type_line FROM cards WHERE id = ?1")
        .map_err(|e| e.to_string())?;
    let parts = card
        .get("all_parts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten();
    for part in parts {
        let (Some(part_id), Some(name), Some(component)) = (
            str_field(part, "id"),
            str_field(part, "name"),
            str_field(part, "component"),
        ) else {
            continue;
        };
        let target: Option<(String, Option<String>, Option<String>)> = resolve
            .query_row(params![part_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .optional()
            .map_err(|e| e.to_string())?;
        // Self, by identity: this printing, or any printing of the same card.
        if part_id == id
            || target
                .as_ref()
                .is_some_and(|t| own_oracle.is_some() && t.1 == own_oracle)
        {
            continue;
        }
        let is_extra = target
            .as_ref()
            .is_some_and(|t| EXTRA_LAYOUTS.contains(&t.0.as_str()));
        let relation = match component.as_str() {
            _ if is_extra => "emblem",
            "token" => "token",
            "meld_part" => "meldPart",
            "meld_result" => "meldResult",
            "combo_piece" => "comboPiece",
            _ => continue,
        };
        let resolved = target.is_some();
        named.extend(target.iter().filter_map(|t| t.1.clone()));
        out.push(RelatedCard {
            relation: relation.to_owned(),
            name,
            card_id: resolved.then_some(part_id),
            type_line: target
                .and_then(|t| t.2)
                .or_else(|| str_field(part, "type_line")),
        });
    }

    let text = rules_text(&card);
    for marker in MARKERS.iter() {
        if !marker.words.iter().any(|w| text.contains(w)) {
            continue;
        }
        for p in marker_printings(conn, marker.helpers)? {
            if named.contains(&p.oracle_id) {
                continue;
            }
            out.push(RelatedCard {
                relation: "helper".to_owned(),
                name: p.name,
                card_id: Some(p.id),
                type_line: p.type_line,
            });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn card(
        conn: &Connection,
        id: &str,
        oracle: &str,
        name: &str,
        layout: &str,
        type_line: &str,
        raw: &Value,
    ) {
        conn.execute(
            "INSERT INTO cards (id, oracle_id, name, set_code, collector_number, lang, layout,
                released_at, rarity, type_line, is_paper, search_text, raw)
             VALUES (?1, ?2, ?3, 'tst', ?1, 'en', ?4, '2020-01-01', 'rare', ?5, 1, ?3, ?6)",
            params![
                id,
                oracle,
                name,
                layout,
                type_line,
                crate::card_row::gzip_raw(&raw.to_string())
            ],
        )
        .unwrap();
    }

    fn plain(conn: &Connection, id: &str, oracle: &str, name: &str, layout: &str, tl: &str) {
        card(conn, id, oracle, name, layout, tl, &json!({ "id": id }));
    }

    fn part(id: &str, name: &str, component: &str, type_line: &str) -> Value {
        json!({ "id": id, "name": name, "component": component, "type_line": type_line })
    }

    fn pairs(got: &[RelatedCard]) -> Vec<(&str, &str)> {
        got.iter()
            .map(|r| (r.relation.as_str(), r.name.as_str()))
            .collect()
    }

    #[test]
    fn a_card_s_tokens_and_emblems_are_named() {
        let conn = crate::schema::memory_pair();
        let raw = json!({ "all_parts": [
            part("m", "Maker", "combo_piece", "Planeswalker"),
            part("t", "Soldier", "token", "Token Creature — Soldier"),
            part("e", "Maker Emblem", "combo_piece", "Emblem — Maker"),
        ]});
        card(&conn, "m", "o-m", "Maker", "normal", "Planeswalker", &raw);
        plain(
            &conn,
            "t",
            "o-t",
            "Soldier",
            "token",
            "Token Creature — Soldier",
        );
        plain(
            &conn,
            "e",
            "o-e",
            "Maker Emblem",
            "emblem",
            "Emblem — Maker",
        );
        let got = related_cards(&conn, "m").unwrap();
        assert_eq!(
            pairs(&got),
            [("token", "Soldier"), ("emblem", "Maker Emblem")]
        );
        assert_eq!(got[0].card_id.as_deref(), Some("t"));
        assert_eq!(
            got[0].type_line.as_deref(),
            Some("Token Creature — Soldier")
        );
    }

    #[test]
    fn a_meld_card_names_its_partner_and_result() {
        let conn = crate::schema::memory_pair();
        let raw = json!({ "all_parts": [
            part("r", "Result", "meld_result", "Creature"),
            part("a", "Alpha", "meld_part", "Creature"),
            part("b", "Beta", "meld_part", "Creature"),
        ]});
        card(&conn, "a", "o-a", "Alpha", "meld", "Creature", &raw);
        plain(&conn, "b", "o-b", "Beta", "meld", "Creature");
        plain(&conn, "r", "o-r", "Result", "meld", "Creature");
        let got = related_cards(&conn, "a").unwrap();
        assert_eq!(
            pairs(&got),
            [("meldResult", "Result"), ("meldPart", "Beta")]
        );
    }

    #[test]
    fn the_card_itself_is_left_out_by_oracle_id_but_its_namesake_token_stays() {
        let conn = crate::schema::memory_pair();
        // The self entry names another printing of the card, so only the oracle id catches it.
        let raw = json!({ "all_parts": [
            part("other-printing", "Sacred Cat", "combo_piece", "Creature — Cat"),
            part("tok", "Sacred Cat", "token", "Token Creature — Zombie Cat"),
        ]});
        card(
            &conn,
            "cat",
            "o-cat",
            "Sacred Cat",
            "normal",
            "Creature — Cat",
            &raw,
        );
        plain(
            &conn,
            "other-printing",
            "o-cat",
            "Sacred Cat",
            "normal",
            "Creature — Cat",
        );
        plain(
            &conn,
            "tok",
            "o-tok",
            "Sacred Cat",
            "token",
            "Token Creature — Zombie Cat",
        );
        let got = related_cards(&conn, "cat").unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].relation, "token");
        assert_eq!(got[0].card_id.as_deref(), Some("tok"));
    }

    #[test]
    fn a_card_that_makes_you_the_monarch_names_the_monarch() {
        let conn = crate::schema::memory_pair();
        let raw = json!({ "oracle_text": "When this enters, you become the monarch." });
        card(&conn, "k", "o-k", "King", "normal", "Creature", &raw);
        plain(&conn, "mon", "o-mon", "The Monarch", "token", "Card");
        let got = related_cards(&conn, "k").unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].relation, "helper");
        assert_eq!(got[0].name, "The Monarch");
        assert_eq!(got[0].card_id.as_deref(), Some("mon"));
    }

    #[test]
    fn a_helper_all_parts_already_names_is_answered_once() {
        let conn = crate::schema::memory_pair();
        // The part is one printing of the Monarch; the marker finds the newest, another id.
        let raw = json!({
            "oracle_text": "When this enters, you become the monarch.",
            "all_parts": [part("mon-old", "The Monarch", "combo_piece", "Card")],
        });
        card(&conn, "k", "o-k", "King", "normal", "Creature", &raw);
        plain(&conn, "mon-old", "o-mon", "The Monarch", "token", "Card");
        plain(&conn, "mon-new", "o-mon", "The Monarch", "token", "Card");
        let got = related_cards(&conn, "k").unwrap();
        assert_eq!(pairs(&got), [("comboPiece", "The Monarch")]);
    }

    #[test]
    fn an_unresolved_part_keeps_its_name_without_a_card_id() {
        let conn = crate::schema::memory_pair();
        let raw = json!({ "all_parts": [
            part("gone", "Lost Spirit", "token", "Token Creature — Spirit"),
        ]});
        card(&conn, "m", "o-m", "Maker", "normal", "Creature", &raw);
        let got = related_cards(&conn, "m").unwrap();
        assert_eq!(
            got,
            [RelatedCard {
                relation: "token".into(),
                name: "Lost Spirit".into(),
                card_id: None,
                type_line: Some("Token Creature — Spirit".into()),
            }]
        );
        assert!(related_cards(&conn, "nope").unwrap().is_empty());
    }
}
