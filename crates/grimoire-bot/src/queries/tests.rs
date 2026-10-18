//! The reads, over a seeded pair.

use super::*;

/// The pair at head, seeded with a little of everything: two printings of one card in two
/// finishes and three folders, a double-faced card, wishes for a printing and for any printing,
/// and a deck with three piles and a label.
pub(crate) fn seeded() -> Connection {
    let conn = grimoire_core::schema::memory_pair();
    conn.execute_batch(
        r#"
        INSERT INTO cards (id, oracle_id, name, lang, set_code, set_name, collector_number, rarity,
                           layout, type_line, prices, price_usd, image_uris, legalities, raw)
        VALUES
          ('sol-c21', 'o-sol', 'Sol Ring', 'en', 'c21', 'Commander 2021', '263', 'uncommon',
           'normal', 'Artifact', '{"usd":"1.50","usd_foil":"9.00"}', 1.5,
           '{"normal":"https://img/sol-c21.jpg","display":"https://img/sol-c21.webp"}', '{"commander":"legal"}', '{}'),
          ('sol-cmr', 'o-sol', 'Sol Ring', 'en', 'cmr', 'Commander Legends', '472', 'uncommon',
           'normal', 'Artifact', '{"usd":"2.00"}', 2.0, NULL, '{"commander":"legal"}', '{}'),
          ('delver', 'o-delver', 'Delver of Secrets // Insectile Aberration', 'en', 'isd',
           'Innistrad', '51', 'common', 'transform', 'Creature — Human Wizard // Creature — Human Insect',
           '{"usd":"0.30"}', 0.3, NULL, '{}', '{}'),
          ('bolt', 'o-bolt', 'Lightning Bolt', 'en', 'm10', 'Magic 2010', '146', 'common',
           'normal', 'Instant', '{"usd":"1.00"}', 1.0, '{"normal":"https://img/bolt.jpg"}', '{}', '{}');
        UPDATE cards SET face_image_uris = '[{"normal":"https://img/delver-front.jpg"},{"normal":"https://img/delver-back.jpg"}]'
         WHERE id = 'delver';

        INSERT INTO collection_folders (id, parent_id, name, kind, sort_order, created_at, updated_at)
        VALUES (501, NULL, 'Binder', 'user', 0, 0, 0), (502, 501, 'Artifacts', 'user', 0, 0, 0),
               (503, NULL, 'Box', 'user', 1, 0, 0);

        INSERT INTO collection_entries (card_id, set_code, collector_number, finish, quantity,
                                        created_at, updated_at, folder_id)
        VALUES ('sol-c21', 'c21', '263', 'foil', 2, 0, 0, 502),
               ('sol-c21', 'c21', '263', 'nonfoil', 1, 0, 0, 503),
               ('sol-cmr', 'cmr', '472', 'nonfoil', 3, 0, 0, NULL),
               ('delver', 'isd', '51', 'nonfoil', 4, 0, 0, NULL),
               ('bolt', 'm10', '146', 'nonfoil', 0, 0, 0, NULL);

        INSERT INTO wishlist_folders (id, parent_id, name, sort_order, created_at, updated_at)
        VALUES (501, NULL, 'Upgrades', 0, 0, 0);
        INSERT INTO wishlist_entries (oracle_id, card_id, set_code, collector_number, lang, name,
                                      quantity, preferred_finish, created_at, updated_at, folder_id)
        VALUES ('o-sol', 'sol-c21', 'c21', '263', 'en', 'Sol Ring', 1, 'foil', 0, 0, 501),
               ('o-mox', NULL, NULL, NULL, NULL, 'Mox Diamond', 2, NULL, 0, 0, NULL);

        INSERT INTO decks (id, name, format_key, created_at, updated_at, sync_uid)
        VALUES (1, 'Artifact Storm', 'commander', 0, 0, 'deck-uid-1'),
               (2, 'Burn', 'modern', 0, 0, 'deck-uid-2'),
               (3, 'Old Burn', 'modern', 0, 0, 'deck-uid-3');
        UPDATE decks SET archived = 1 WHERE id = 3;
        INSERT INTO deck_categories (id, deck_id, name, kind, is_active, sort_order, created_at, updated_at)
        VALUES (10, 1, 'Commander', 'commander', 1, 0, 0, 0),
               (11, 1, 'Ramp', 'main', 1, 1, 0, 0),
               (12, 1, 'Maybeboard', 'maybe', 0, 2, 0, 0),
               (20, 2, 'Main deck', 'main', 1, 0, 0, 0);
        INSERT INTO deck_labels (id, name, name_key, color, created_at, updated_at)
        VALUES (1, 'Keeper', 'keeper', '#4aab08', 0, 0);
        INSERT INTO deck_cards (deck_id, category_id, card_id, set_code, collector_number, lang, name,
                                label_id, quantity, created_at, updated_at, finish)
        VALUES (1, 11, 'sol-c21', 'c21', '263', 'en', 'Sol Ring', 1, 1, 0, 0, 'foil'),
               (1, 10, 'delver', 'isd', '51', 'en', 'Delver of Secrets // Insectile Aberration', NULL, 1, 0, 0, NULL),
               (1, 12, 'bolt', 'm10', '146', 'en', 'Lightning Bolt', NULL, 2, 0, 0, NULL),
               (2, 20, 'bolt', 'm10', '146', 'en', 'Lightning Bolt', NULL, 4, 0, 0, NULL);
        "#,
    )
    .unwrap();
    conn
}

#[test]
fn a_card_is_every_printing_finish_and_folder_held() {
    let conn = seeded();
    let held = collection_by_name(&conn, "sol ring").unwrap().unwrap();
    assert_eq!(held.name, "Sol Ring");
    assert_eq!(held.total, 6);
    assert_eq!(held.more, 0);
    assert_eq!(held.type_line.as_deref(), Some("Artifact"));
    assert_eq!(held.image.as_deref(), Some("https://img/sol-c21.jpg"));
    let lines: Vec<(i64, &str, &str, Option<&str>)> = held
        .lines
        .iter()
        .map(|l| {
            (
                l.quantity,
                l.set_code.as_deref().unwrap(),
                l.finish.as_deref().unwrap(),
                l.folder.as_deref(),
            )
        })
        .collect();
    assert_eq!(
        lines,
        vec![
            (3, "cmr", "nonfoil", None),
            (2, "c21", "foil", Some("Binder/Artifacts")),
            (1, "c21", "nonfoil", Some("Box")),
        ]
    );
    assert_eq!(held.lines[1].price_usd, Some(9.0), "the foil's own price");
    assert_eq!(held.lines[2].price_usd, Some(1.5));
    assert_eq!(held.lines[1].set_name.as_deref(), Some("Commander 2021"));
}

#[test]
fn a_double_faced_card_answers_to_its_front_face_and_shows_it() {
    let conn = seeded();
    let held = collection_by_name(&conn, "Delver of Secrets")
        .unwrap()
        .unwrap();
    assert_eq!(held.name, "Delver of Secrets // Insectile Aberration");
    assert_eq!(held.image.as_deref(), Some("https://img/delver-front.jpg"));
    assert_eq!(held.total, 4);
}

#[test]
fn a_card_held_at_zero_or_never_is_not_held() {
    let conn = seeded();
    assert_eq!(collection_by_name(&conn, "Lightning Bolt").unwrap(), None);
    assert_eq!(collection_by_name(&conn, "Black Lotus").unwrap(), None);
    assert_eq!(collection_by_name(&conn, "  ").unwrap(), None);
}

#[test]
fn a_card_held_in_many_rows_is_bounded_and_counts_the_rest() {
    let conn = seeded();
    for i in 0..(MAX_LINES as i64 + 7) {
        conn.execute(
            "INSERT INTO collection_folders (id, parent_id, name, kind, sort_order, created_at, updated_at)
             VALUES (?1, NULL, 'Folder ' || ?1, 'user', 0, 0, 0)",
            [1000 + i],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO collection_entries (card_id, set_code, collector_number, finish, quantity,
                                             created_at, updated_at, folder_id)
             VALUES ('bolt', 'm10', '146', 'nonfoil', 1, 0, 0, ?1)",
            [1000 + i],
        )
        .unwrap();
    }
    let held = collection_by_name(&conn, "Lightning Bolt")
        .unwrap()
        .unwrap();
    assert_eq!(held.lines.len(), MAX_LINES);
    assert_eq!(held.more, 7);
    assert_eq!(held.total, MAX_LINES as i64 + 7);
}

#[test]
fn a_wish_is_its_printing_or_any_and_its_folder() {
    let conn = seeded();
    let wish = wishlist_by_name(&conn, "Sol Ring").unwrap().unwrap();
    assert_eq!(wish.total, 1);
    assert_eq!(wish.lines[0].finish.as_deref(), Some("foil"));
    assert_eq!(wish.lines[0].folder.as_deref(), Some("Upgrades"));
    assert_eq!(wish.lines[0].set_name.as_deref(), Some("Commander 2021"));
    assert_eq!(wish.lines[0].price_usd, Some(9.0));

    let any = wishlist_by_name(&conn, "mox diamond").unwrap().unwrap();
    assert_eq!(any.name, "Mox Diamond");
    assert_eq!(any.total, 2);
    assert_eq!(any.lines[0].set_code, None, "any printing");
    assert_eq!(any.image, None, "no printing in the corpus yet");
    assert_eq!(wishlist_by_name(&conn, "Delver").unwrap(), None);
}

#[test]
fn autocomplete_offers_what_the_list_holds_prefix_first() {
    let conn = seeded();
    let names = |kind, text| -> Vec<String> {
        super::names(&conn, kind, text, 25)
            .unwrap()
            .into_iter()
            .map(|c| c.name)
            .collect()
    };
    assert_eq!(
        names(Kind::Collection, "s"),
        vec!["Sol Ring", "Delver of Secrets // Insectile Aberration"]
    );
    assert_eq!(
        names(Kind::Collection, "bolt"),
        Vec::<String>::new(),
        "zero copies"
    );
    assert_eq!(names(Kind::Wishlist, ""), vec!["Mox Diamond", "Sol Ring"]);
    let decks = super::names(&conn, Kind::Deck, "burn", 25).unwrap();
    assert_eq!(
        decks,
        vec![Choice {
            name: "Burn".into(),
            value: "deck-uid-2".into()
        }],
        "an archived deck is not offered, and a deck's value is its uid"
    );
}

#[test]
fn autocomplete_keeps_to_discords_limits() {
    let conn = seeded();
    let long = "A".repeat(150);
    for i in 0..40 {
        conn.execute(
            "INSERT INTO wishlist_entries (oracle_id, name, quantity, created_at, updated_at)
             VALUES ('o' || ?1, ?1, 1, 0, 0)",
            [format!("{long}{i:02}")],
        )
        .unwrap();
    }
    let choices = super::names(&conn, Kind::Wishlist, "a", 999).unwrap();
    assert_eq!(choices.len(), MAX_NAMES);
    for c in &choices {
        assert!(c.name.chars().count() <= MAX_CHOICE_CHARS);
        assert!(c.value.chars().count() <= MAX_CHOICE_CHARS);
    }
    assert_eq!(clip("ééé", 2), "éé", "never through a character");
}

#[test]
fn deck_cards_are_transfer_cards_in_pile_order() {
    let conn = seeded();
    let list = deck_cards(&conn, "deck-uid-1").unwrap().unwrap();
    assert_eq!(list.deck.name, "Artifact Storm");
    assert_eq!(list.deck.cards, 4);
    let names: Vec<_> = list
        .cards
        .iter()
        .map(|c| c.category_name.clone().unwrap())
        .collect();
    assert_eq!(names, vec!["Commander", "Ramp", "Maybeboard"]);
    let sol = &list.cards[1];
    assert_eq!(sol.finish.as_deref(), Some("foil"));
    assert_eq!(sol.label_name.as_deref(), Some("Keeper"));
    assert_eq!(sol.label_color.as_deref(), Some("#4aab08"));
    assert_eq!(sol.unit_price, Some(9.0));
    assert_eq!(sol.set_name.as_deref(), Some("Commander 2021"));
    assert_eq!(list.cards[2].category_active, Some(false));
    assert_eq!(list.cards[0].category_kind.as_deref(), Some("commander"));

    // The thirty keys `TransferCard.ts` declares, and nothing else.
    let json = serde_json::to_value(sol).unwrap();
    let mut keys: Vec<&str> = json
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort();
    let mut want = vec![
        "name",
        "quantity",
        "setCode",
        "collectorNumber",
        "finish",
        "lang",
        "categoryName",
        "categoryKind",
        "categoryActive",
        "condition",
        "tradelistQuantity",
        "purchasePrice",
        "purchaseCurrency",
        "acquiredAt",
        "acquisitionSource",
        "serialNumber",
        "grading",
        "altered",
        "signed",
        "proxy",
        "misprint",
        "tags",
        "notes",
        "setName",
        "rarity",
        "typeLine",
        "unitPrice",
        "labelName",
        "labelColor",
        "legalities",
    ];
    want.sort();
    assert_eq!(keys, want);
    assert!(json["condition"].is_null());
}

#[test]
fn a_deck_is_found_by_uid_or_by_name_and_listed_by_prefix() {
    let conn = seeded();
    assert_eq!(
        deck_cards(&conn, "burn").unwrap().unwrap().deck.uid,
        "deck-uid-2"
    );
    assert_eq!(deck_cards(&conn, "nope").unwrap(), None);
    let listed: Vec<_> = decks(&conn, "")
        .unwrap()
        .into_iter()
        .map(|d| d.name)
        .collect();
    assert_eq!(listed, vec!["Artifact Storm", "Burn"]);
}
