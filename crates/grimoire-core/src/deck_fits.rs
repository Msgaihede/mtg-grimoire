//! **Cards the reader owns that a deck could play and does not** — the collection-aware half of a
//! deck review (MCP project E, `docs/superpowers/specs/2026-11-25-mcp-decks-design.md` §6.3).
//!
//! A card fits when the reader owns a copy of it (any printing, finish or folder — the same count
//! `ComboPiece.owned` reads), some printing of it is legal in the deck's format (when the format
//! has legality data), its colour identity fits inside the deck's
//! ([`crate::deck_rules::deck_identity`]: the commanders', else the active cards' union), and no
//! active pile of the list already plays it (by oracle card, so another printing of a card the
//! deck runs is not offered). The caller narrows by name words, oracle tags (all of which a card
//! must hold), card types and mana values, with `filters.rs`' own clauses.
//!
//! Ordered by EDHREC rank (most played first; an unranked card after every ranked one), then by
//! name, so two runs page alike. Read-only, no network.

use crate::deck::{get_deck, list_format_specs};
use crate::deck_rules::{deck_identity, DeckIdentity};
use crate::filters::{push_card_filters, CardFilters, Predicates, TagTerms};
use crate::sorting::Marketplace;
use rusqlite::{params_from_iter, Connection};
use serde::Serialize;

/// The most cards one answer holds.
pub const MAX_LIMIT: i64 = 100;

/// `deck_owned_fits`' answer: one page of the owned cards that fit, and how many there are.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnedFits {
    pub deck_id: i64,
    pub variant: String,
    /// The identity the candidates were held to, or `None` when the deck has none to read (an
    /// empty deck), in which case colour narrows nothing.
    pub identity: Option<DeckIdentity>,
    /// The legality key the candidates were held to, or `None` when the deck's format has no
    /// legality data (`casual`, `limited`, `unspecified`), in which case legality narrows nothing.
    pub format: Option<String>,
    /// Every card that fits, of which `cards` is one page.
    pub total: i64,
    pub cards: Vec<OwnedFit>,
}

/// One owned card that fits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnedFit {
    pub oracle_id: String,
    pub name: String,
    /// The printing the reader owns the most copies of (ties by id).
    pub card_id: String,
    pub type_line: Option<String>,
    pub mana_cost: Option<String>,
    /// Copies the reader owns, every printing and finish together.
    pub owned: i64,
    /// How many of those are filed in a deck's group — sleeved in another deck.
    pub in_decks: i64,
    pub edhrec_rank: Option<i64>,
}

/// One page of the owned cards that fit `deck_id`'s `variant` list, narrowed by `words` (each a
/// case-insensitive part of the name), `oracle_tags` (slugs, all held), `types` and `mana_values`
/// (`filters.rs`' meanings: a type the card has, a mana value with 8 for 8 or more). `None` for a
/// deck that does not exist. `limit` is clamped to `1..=100`, `offset` to `0..`.
#[allow(clippy::too_many_arguments)]
pub fn owned_fits(
    conn: &Connection,
    deck_id: i64,
    variant: &str,
    words: &[String],
    oracle_tags: &[String],
    types: &[String],
    mana_values: &[u8],
    limit: i64,
    offset: i64,
) -> Result<Option<OwnedFits>, String> {
    let Some(detail) = get_deck(conn, deck_id, variant, Marketplace::from_opt(None))? else {
        return Ok(None);
    };
    let spec = list_format_specs(conn)?
        .into_iter()
        .find(|s| s.key == detail.deck.format_key);
    let identity = deck_identity(&detail.cards, spec.as_ref());
    let format = spec.filter(|s| s.has_legality_data).map(|s| s.key);
    let mut playing: Vec<&str> = detail
        .cards
        .iter()
        .filter(|c| c.category_active)
        .filter_map(|c| c.oracle_id.as_deref())
        .collect();
    playing.sort_unstable();
    playing.dedup();

    let mut filters = Predicates::default();
    push_card_filters(
        &mut filters,
        &CardFilters {
            format: format.clone(),
            // `"C"` is the filter's word for the empty identity.
            colors: identity.as_ref().map(|i| match i.letters.as_str() {
                "" => "C".to_owned(),
                letters => letters.to_owned(),
            }),
            types: (!types.is_empty()).then(|| types.to_vec()),
            mana_values: (!mana_values.is_empty()).then(|| mana_values.to_vec()),
            oracle_tags: (!oracle_tags.is_empty()).then(|| TagTerms {
                include: oracle_tags.to_vec(),
                exclude: Vec::new(),
            }),
            ..Default::default()
        },
        "d",
        None,
    );
    let named: Vec<String> = words
        .iter()
        .map(|w| w.trim().to_lowercase())
        .filter(|w| !w.is_empty())
        .collect();
    let name_sql: String = named
        .iter()
        .map(|_| " AND instr(lower(o.nm), ?) > 0")
        .collect();
    let fits = format!(
        "WITH owned(oid, nm, copies, in_decks, rk) AS (
             SELECT c.oracle_id, min(c.name), sum(e.quantity),
                    sum(CASE WHEN f.kind = 'deck' THEN e.quantity ELSE 0 END),
                    min(c.edhrec_rank)
               FROM collection_entries e
               JOIN cards c ON c.id = e.card_id
               LEFT JOIN collection_folders f ON f.id = e.folder_id
              WHERE c.oracle_id IS NOT NULL
              GROUP BY c.oracle_id),
         fits AS (
             SELECT o.* FROM owned o
              WHERE o.oid NOT IN (SELECT value FROM json_each(?))
                AND EXISTS (SELECT 1 FROM cards d WHERE d.oracle_id = o.oid AND {filters})
                {name_sql})",
        filters = filters.where_sql(),
    );
    let page = format!(
        "{fits}
         SELECT f.oid, f.nm, f.copies, f.in_decks, f.rk, p.id, p.type_line, p.mana_cost
           FROM fits f
           JOIN cards p ON p.id = (
                SELECT e.card_id FROM collection_entries e JOIN cards c ON c.id = e.card_id
                 WHERE c.oracle_id = f.oid
                 GROUP BY e.card_id ORDER BY sum(e.quantity) DESC, e.card_id LIMIT 1)
          ORDER BY f.rk IS NULL, f.rk, f.nm, f.oid
          LIMIT ? OFFSET ?"
    );
    let mut binds: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(
        serde_json::to_string(&playing).map_err(|e| e.to_string())?,
    )];
    binds.append(&mut filters.params);
    for word in named {
        binds.push(Box::new(word));
    }
    let asked = binds.len();
    binds.push(Box::new(limit.clamp(1, MAX_LIMIT)));
    binds.push(Box::new(offset.max(0)));
    let fail = |e: rusqlite::Error| format!("could not read the owned cards that fit: {e}");
    let total: i64 = conn
        .query_row(
            &format!("{fits} SELECT count(*) FROM fits"),
            params_from_iter(binds[..asked].iter().map(|b| b.as_ref())),
            |r| r.get(0),
        )
        .map_err(fail)?;
    let mut stmt = conn.prepare(&page).map_err(fail)?;
    let cards = stmt
        .query_map(params_from_iter(binds.iter().map(|b| b.as_ref())), |r| {
            Ok(OwnedFit {
                oracle_id: r.get(0)?,
                name: r.get(1)?,
                owned: r.get(2)?,
                in_decks: r.get(3)?,
                edhrec_rank: r.get(4)?,
                card_id: r.get(5)?,
                type_line: r.get(6)?,
                mana_cost: r.get(7)?,
            })
        })
        .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
        .map_err(fail)?;
    Ok(Some(OwnedFits {
        deck_id,
        variant: variant.to_owned(),
        identity,
        format,
        total,
        cards,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deck::fixtures::{input, kind_of, main_of};
    use crate::deck::{add_card, create_deck};
    use rusqlite::params;

    /// A Commander-legal, unranked printing.
    fn card(conn: &Connection, id: &str, oracle: &str, name: &str, kind: &str, identity: &str) {
        card_ranked(conn, id, oracle, name, kind, identity, true, None);
    }

    #[allow(clippy::too_many_arguments)]
    fn card_ranked(
        conn: &Connection,
        id: &str,
        oracle: &str,
        name: &str,
        type_line: &str,
        identity: &str,
        legal: bool,
        rank: Option<i64>,
    ) {
        conn.execute(
            "INSERT INTO cards (id, oracle_id, name, set_code, collector_number, lang, layout,
                                rarity, released_at, type_line, type_mask, mana_cost, cmc,
                                color_identity, legalities, legal_mask, edhrec_rank, raw)
             VALUES (?1, ?2, ?3, 'tst', ?1, 'en', 'normal', 'common', '2020-01-01', ?4, ?8,
                     '{2}', 2.0, ?5, '{}', ?6, ?7, '{}')",
            params![
                id,
                oracle,
                name,
                type_line,
                identity,
                if legal {
                    crate::legalities::bit("commander").unwrap() as i64
                } else {
                    0
                },
                rank,
                i64::from(crate::cardtypes::type_mask(type_line)),
            ],
        )
        .unwrap();
    }

    fn own(conn: &Connection, card_id: &str, quantity: i64) {
        crate::collection::add_entry(
            conn,
            &crate::collection::EntryInput {
                card_id: card_id.to_owned(),
                finish: "nonfoil".to_owned(),
                quantity,
                ..Default::default()
            },
        )
        .unwrap();
    }

    fn put(conn: &Connection, deck: i64, card: &str, pile: i64) {
        add_card(conn, deck, card, Some(pile), None, "live", None, 1).unwrap();
    }

    fn names(fits: &OwnedFits) -> Vec<&str> {
        fits.cards.iter().map(|c| c.name.as_str()).collect()
    }

    fn fits(conn: &Connection, deck: i64) -> OwnedFits {
        owned_fits(conn, deck, "live", &[], &[], &[], &[], 20, 0)
            .unwrap()
            .unwrap()
    }

    /// A Commander deck led by a mono-green commander, with one green card in it, and an owned
    /// collection of: that card, another green one, a blue one, a colourless one, an illegal one.
    fn green_deck(conn: &Connection) -> i64 {
        card(
            conn,
            "cmd",
            "o-cmd",
            "Green Leader",
            "Legendary Creature — Elf",
            "G",
        );
        card_ranked(
            conn,
            "elf",
            "o-elf",
            "Llanowar Elves",
            "Creature — Elf",
            "G",
            true,
            Some(5),
        );
        card_ranked(
            conn,
            "ramp",
            "o-ramp",
            "Rampant Growth",
            "Sorcery",
            "G",
            true,
            Some(40),
        );
        card_ranked(
            conn,
            "ring",
            "o-ring",
            "Sol Ring",
            "Artifact",
            "",
            true,
            Some(1),
        );
        card(conn, "counter", "o-counter", "Counterspell", "Instant", "U");
        card_ranked(
            conn,
            "bad",
            "o-bad",
            "Banned Thing",
            "Artifact",
            "",
            false,
            Some(2),
        );
        card(conn, "rock", "o-rock", "Unranked Rock", "Artifact", "");
        for (id, n) in [
            ("cmd", 1),
            ("elf", 2),
            ("ramp", 1),
            ("ring", 1),
            ("counter", 1),
            ("bad", 1),
            ("rock", 3),
        ] {
            own(conn, id, n);
        }
        let deck = create_deck(conn, &input("Elves", "commander")).unwrap().id;
        put(conn, deck, "cmd", kind_of(conn, deck, "commander"));
        put(conn, deck, "elf", main_of(conn, deck));
        deck
    }

    #[test]
    fn owned_cards_that_fit_the_commander_and_the_format_and_are_not_in_the_deck() {
        let conn = crate::schema::memory_pair();
        let deck = green_deck(&conn);
        let got = fits(&conn, deck);
        assert_eq!(
            got.identity,
            Some(DeckIdentity {
                letters: "G".to_owned(),
                from: "commanders"
            })
        );
        assert_eq!(got.format.as_deref(), Some("commander"));
        // EDHREC rank first, an unranked card last; the blue, the illegal and the played ones out.
        assert_eq!(names(&got), ["Sol Ring", "Rampant Growth", "Unranked Rock"]);
        assert_eq!(got.total, 3);
        assert_eq!(got.cards[2].owned, 3);
    }

    #[test]
    fn a_switched_off_pile_does_not_count_as_playing_the_card() {
        let conn = crate::schema::memory_pair();
        let deck = green_deck(&conn);
        put(&conn, deck, "ramp", kind_of(&conn, deck, "maybe"));
        assert!(names(&fits(&conn, deck)).contains(&"Rampant Growth"));
    }

    #[test]
    fn narrowed_by_name_words_and_types_and_paged() {
        let conn = crate::schema::memory_pair();
        let deck = green_deck(&conn);
        let words = vec!["ROCK".to_owned()];
        let got = owned_fits(&conn, deck, "live", &words, &[], &[], &[], 20, 0)
            .unwrap()
            .unwrap();
        assert_eq!(names(&got), ["Unranked Rock"]);
        let types = vec!["Sorcery".to_owned()];
        let got = owned_fits(&conn, deck, "live", &[], &[], &types, &[], 20, 0)
            .unwrap()
            .unwrap();
        assert_eq!(names(&got), ["Rampant Growth"]);
        let page = owned_fits(&conn, deck, "live", &[], &[], &[], &[], 1, 1)
            .unwrap()
            .unwrap();
        assert_eq!((names(&page), page.total), (vec!["Rampant Growth"], 3));
        let past = owned_fits(&conn, deck, "live", &[], &[], &[], &[], 5, 10)
            .unwrap()
            .unwrap();
        assert_eq!((past.cards.len(), past.total), (0, 3));
    }

    #[test]
    fn a_deck_with_no_commander_fits_its_cards_and_a_casual_one_no_format() {
        let conn = crate::schema::memory_pair();
        green_deck(&conn);
        let deck = create_deck(&conn, &input("Pile", "casual")).unwrap().id;
        put(&conn, deck, "elf", main_of(&conn, deck));
        let got = fits(&conn, deck);
        assert_eq!(got.identity.as_ref().unwrap().from, "cards");
        assert_eq!(got.format, None);
        // Banned Thing is legal nowhere, but casual has no legality data to hold it to.
        assert!(names(&got).contains(&"Banned Thing"));
        assert!(!names(&got).contains(&"Counterspell"));

        let empty = create_deck(&conn, &input("Empty", "casual")).unwrap().id;
        let got = fits(&conn, empty);
        assert_eq!(got.identity, None);
        assert!(names(&got).contains(&"Counterspell"));
        assert!(owned_fits(&conn, 999, "live", &[], &[], &[], &[], 5, 0)
            .unwrap()
            .is_none());
    }
}
