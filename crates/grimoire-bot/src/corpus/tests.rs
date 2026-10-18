//! The slim corpus, against a mock Scryfall.

use super::*;
use httpmock::prelude::*;

/// A Scryfall card object, as `/cards/collection` answers one.
pub(crate) fn scryfall_card(id: &str, name: &str, set: &str, number: &str) -> Value {
    json!({
        "object": "card", "id": id, "oracle_id": format!("o-{id}"), "name": name, "lang": "en",
        "released_at": "2021-04-23", "set": set, "set_name": format!("Set {set}"),
        "collector_number": number, "rarity": "uncommon", "layout": "normal",
        "type_line": "Artifact", "mana_cost": "{1}", "cmc": 1.0,
        "finishes": ["nonfoil", "foil"], "games": ["paper"],
        "prices": { "usd": "1.25", "usd_foil": "4.00", "eur": null },
        "legalities": { "commander": "legal" },
        "image_uris": {
            "normal": format!("https://cards.scryfall.io/normal/{id}.jpg"),
            "display": format!("https://cards.scryfall.io/display/{id}.webp")
        }
    })
}

fn seeded() -> Connection {
    let conn = grimoire_core::schema::memory_pair();
    conn.execute_batch(
        "INSERT INTO collection_entries (card_id, set_code, collector_number, finish, quantity,
                                         created_at, updated_at)
         VALUES ('a', 'c21', '1', 'nonfoil', 1, 0, 0), ('b', 'c21', '2', 'foil', 2, 0, 0),
                ('gone', 'xxx', '9', 'nonfoil', 1, 0, 0);
         INSERT INTO wishlist_entries (oracle_id, name, quantity, created_at, updated_at)
         VALUES ('o-mox', 'Mox Diamond', 1, 0, 0);",
    )
    .unwrap();
    conn
}

#[test]
fn what_is_wanted_is_what_the_rows_name_and_the_corpus_lacks() {
    let conn = seeded();
    let wanted = wanted(&conn, 1_000, 10).unwrap();
    assert_eq!(
        wanted,
        vec![
            Wanted::Id("a".into()),
            Wanted::Id("b".into()),
            Wanted::Id("gone".into()),
            Wanted::Name("Mox Diamond".into()),
        ]
    );
    assert_eq!(super::wanted(&conn, 1_000, 2).unwrap().len(), 2, "bounded");
}

#[test]
fn a_stored_card_fills_every_column_the_core_needs_and_keeps_the_jpeg() {
    let conn = seeded();
    assert!(store_card(&conn, &scryfall_card("a", "Sol Ring", "c21", "1")).unwrap());
    let (name, set_name, price, normal, produced, raw): (
        String,
        String,
        f64,
        String,
        String,
        String,
    ) = conn
        .query_row(
            "SELECT name, set_name, price_usd, json_extract(image_uris, '$.normal'),
                    produced_mana, raw FROM cards WHERE id = 'a'",
            [],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(name, "Sol Ring");
    assert_eq!(set_name, "Set c21");
    assert_eq!(price, 1.25);
    assert_eq!(normal, "https://cards.scryfall.io/normal/a.jpg");
    assert_eq!(produced, "", "a derived column is filled, never NULL");
    assert_eq!(raw, "{}");
    assert!(!store_card(&conn, &json!({"object": "error"})).unwrap());
}

#[tokio::test(flavor = "current_thread")]
async fn a_fill_asks_in_batches_and_remembers_what_scryfall_did_not_know() {
    let server = MockServer::start_async().await;
    let asked = server.mock(|when, then| {
        when.method(POST)
            .path("/cards/collection")
            .header("user-agent", grimoire_core::scryfall::USER_AGENT)
            .header_exists("accept");
        then.status(200).json_body(json!({
            "object": "list",
            "not_found": [{ "id": "gone" }],
            "data": [
                scryfall_card("a", "Sol Ring", "c21", "1"),
                scryfall_card("b", "Arcane Signet", "c21", "2"),
                scryfall_card("mox", "Mox Diamond", "tmp", "138"),
            ]
        }));
    });
    let conn = seeded();
    let filled = fill(&conn, &client(), &server.base_url(), 4, 1_000)
        .await
        .unwrap();
    assert_eq!(filled.requests, 1);
    assert_eq!(filled.stored, 3);
    assert_eq!(filled.unknown, 1);
    assert!(!filled.more);
    asked.assert_calls(1);
    // Nothing is asked again: the known three are in the corpus, the unknown one is remembered.
    assert!(wanted(&conn, 1_000, 10).unwrap().is_empty());
    // And a week on, the printings Scryfall knew are asked again for their prices.
    let later = wanted(&conn, 1_000 + REFRESH_SECS + 1, 10).unwrap();
    assert_eq!(later, vec![Wanted::Id("a".into()), Wanted::Id("b".into())]);
}

#[tokio::test(flavor = "current_thread")]
async fn a_throttled_fill_stops_and_asks_for_more() {
    let server = MockServer::start_async().await;
    server.mock(|when, then| {
        when.method(POST).path("/cards/collection");
        then.status(429);
    });
    let conn = seeded();
    let filled = fill(&conn, &client(), &server.base_url(), 4, 1_000)
        .await
        .unwrap();
    assert!(filled.throttled);
    assert!(filled.more);
    assert_eq!(filled.requests, 1);
    assert_eq!(
        wanted(&conn, 1_000, 10).unwrap().len(),
        4,
        "nothing was recorded"
    );
}
