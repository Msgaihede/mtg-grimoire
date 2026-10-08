//! **Which of a deck's cards answer the search terms typed into the editor's `Filter this deck`
//! box** — issue #621.
//!
//! The box reads the same Scryfall-and-app syntax as every other card search box (`t:goblin`,
//! `cmc>=3`, `-kw:flying`, `otag:removal`, `f:modern`), parsed by
//! `packages/ui/features/search/queryLanguage.ts` into [`crate::filters::QueryPredicate`]s and resolved
//! tag slugs. **Nothing here re-implements a single one of those terms**: the typed ones ride
//! [`crate::filters::fts_match`] and [`crate::filters::push_card_filters`], the two functions the
//! search, the collection and the wishlist already call, so `t:goblin` narrows a deck exactly as
//! it narrows the search wall. A TypeScript evaluator over the deck's in-memory rows was the
//! alternative and was refused for that reason: it would be a second implementation of thirteen
//! fields' semantics — `c:` against `id:`, rarity's order, a star power, the `kw:` bridge — and
//! it could not answer three of them at all, because a `DeckCard` carries no keywords, no artist
//! and no tags.
//!
//! **The free text is not asked here.** The box has always matched plain words as a substring of
//! a card's name or type line, in the webview and per keystroke, and that stays — an FTS prefix
//! match would quietly change what `bolt` or `oblin` answer. So [`CardFilters::text`] is forced
//! off and the caller intersects this answer with its own substring test.
//!
//! **The answer is printings, not rows**: every term is a statement about a *card*, so two rows
//! of one printing (a foil and a regular copy, or one card in two piles) always answer together,
//! and a row added after the read is matched by its printing the moment it is drawn rather than
//! waiting for a re-read. Both lists of the deck are asked at once, for the same reason — the
//! caller's key does not have to carry the variant.
//!
//! **An orphan fails every term**, which is `push_card_filters`' documented rule inherited rather
//! than a new one: a row whose printing has left `cards` has nothing a card claim can be read
//! from, so it is drawn by the free text alone and never by a typed term. The one exception is
//! the set code, which the row carries itself (`deck_cards.set_code`), exactly as the collection
//! reads its entry's own code.

use crate::filters::CardFilters;
use rusqlite::Connection;

/// The distinct printings of `deck_id`, in either list, that answer every typed term in
/// `filters`. Sorted, so an answer is one value however SQLite happened to walk the rows.
///
/// A deck that is not there answers an empty list rather than a refusal: the editor asks this
/// while it is drawing a deck, and a deck deleted under it is already said by `deck_get`.
pub fn query_cards(
    conn: &Connection,
    deck_id: i64,
    filters: &CardFilters,
) -> Result<Vec<String>, String> {
    let mut p = crate::filters::Predicates::default();
    // The deck first, so its placeholder is the first `?` and every fragment below binds after
    // it — the builder's one invariant is that a fragment and its parameter are never separated.
    p.push("dc.deck_id = ?".to_owned(), Box::new(deck_id));

    // The `t:`/`o:`/`-bolt` terms, through the index — the collection's `scope`, down to the
    // subquery over `c.rowid` rather than a join: over this LEFT JOIN an orphan's rowid is NULL,
    // a joined FTS5 constraint drops a NULL rowid rather than failing it, and `NULL IN (…)` is
    // the answer this needs. No free text is passed; see the module note.
    let (matched, negatives) =
        crate::filters::fts_match(None, filters.predicates.as_deref().unwrap_or(&[]));
    if let Some(query) = matched {
        p.push(
            "c.rowid IN (SELECT rowid FROM cards_fts WHERE cards_fts MATCH ?)".to_owned(),
            Box::new(query),
        );
    }
    for negative in negatives {
        p.push(
            "c.rowid NOT IN (SELECT rowid FROM cards_fts WHERE cards_fts MATCH ?)".to_owned(),
            Box::new(negative),
        );
    }

    // `paper_only` is forced off — a deck holds what the reader put in it, and `c.is_paper = 1`
    // over a LEFT JOIN would also throw away every orphan. `text` is forced off for the module
    // note's reason. `Some("dc")` reads a set code through to the row's own copy.
    let cards = CardFilters {
        text: None,
        paper_only: Some(false),
        ..filters.clone()
    };
    crate::filters::push_card_filters(&mut p, &cards, "c", Some("dc"));

    let sql = format!(
        "SELECT DISTINCT dc.card_id FROM deck_cards dc LEFT JOIN cards c ON c.id = dc.card_id
          WHERE {} ORDER BY dc.card_id",
        p.where_sql()
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let params: Vec<&dyn rusqlite::ToSql> = p.params.iter().map(|b| b.as_ref()).collect();
    let rows = stmt
        .query_map(params.as_slice(), |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deck::DeckInput;
    use crate::filters::{PredicateField, PredicateOp, QueryPredicate, TagTerms};

    const LIVE: &str = "live";
    const THEORY: &str = "theory";

    /// A goblin, a bolt in two printings, a flier and an angel — enough to tell the FTS half,
    /// the SQL half and the tag half apart.
    fn seeded() -> (Connection, i64) {
        let conn = crate::schema::memory_pair();
        conn.execute_batch(
            r#"INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                    rarity,mana_cost,cmc,type_line,search_text,colors,color_identity,keywords,
                    prices,raw)
               VALUES
                 ('bolt-lea','o1','Lightning Bolt','lea','161','en','normal','common',
                  '{R}',1.0,'Instant','Lightning Bolt Instant Lightning Bolt deals 3 damage',
                  'R','R',NULL,'{}','{}'),
                 ('bolt-m10','o1','Lightning Bolt','m10','146','en','normal','common',
                  '{R}',1.0,'Instant','Lightning Bolt Instant Lightning Bolt deals 3 damage',
                  'R','R',NULL,'{}','{}'),
                 ('guide','o2','Goblin Guide','zen','126','en','normal','rare',
                  '{R}',1.0,'Creature — Goblin Scout','Goblin Guide Creature Goblin Scout Haste',
                  'R','R','|haste|','{}','{}'),
                 ('serra','o3','Serra Angel','lea','175','en','normal','uncommon',
                  '{3}{W}{W}',5.0,'Creature — Angel','Serra Angel Creature Angel Flying Vigilance',
                  'W','W','|flying|vigilance|','{}','{}');
               INSERT INTO cards_fts(cards_fts) VALUES('rebuild');"#,
        )
        .unwrap();
        let deck = crate::deck::create_deck(
            &conn,
            &DeckInput {
                name: "Test".to_owned(),
                format_key: "modern".to_owned(),
                ..Default::default()
            },
        )
        .unwrap()
        .id;
        for card in ["bolt-lea", "guide", "serra"] {
            add(&conn, deck, card, LIVE);
        }
        (conn, deck)
    }

    fn add(conn: &Connection, deck: i64, card: &str, variant: &str) {
        let pile = crate::deck_meta::category_for_name(conn, deck, variant, "Main").unwrap();
        crate::deck::add_card(conn, deck, card, Some(pile), None, variant, None, 1).unwrap();
    }

    fn term(field: PredicateField, op: PredicateOp, value: &str, negated: bool) -> QueryPredicate {
        QueryPredicate {
            field,
            op,
            value: value.to_owned(),
            negated,
        }
    }

    fn ask(conn: &Connection, deck: i64, preds: Vec<QueryPredicate>) -> Vec<String> {
        query_cards(
            conn,
            deck,
            &CardFilters {
                predicates: Some(preds),
                ..Default::default()
            },
        )
        .unwrap()
    }

    /// Both doors a term can leave by: `t:creature` rides the FTS `MATCH` and `cmc>=3` is SQL
    /// out of `push_card_filters`, and the two AND.
    #[test]
    fn a_typed_term_narrows_the_deck_through_the_search_sql() {
        let (conn, deck) = seeded();
        let creature = || {
            term(
                PredicateField::TypeLine,
                PredicateOp::Colon,
                "creature",
                false,
            )
        };
        assert_eq!(ask(&conn, deck, vec![creature()]), ["guide", "serra"]);
        assert_eq!(
            ask(
                &conn,
                deck,
                vec![
                    creature(),
                    term(PredicateField::Cmc, PredicateOp::Gte, "3", false)
                ]
            ),
            ["serra"]
        );
        assert_eq!(
            ask(
                &conn,
                deck,
                vec![term(
                    PredicateField::TypeLine,
                    PredicateOp::Colon,
                    "creature",
                    true
                )]
            ),
            ["bolt-lea"]
        );
    }

    /// The three fields a `DeckCard` could not answer in the webview — the reason this is Rust.
    #[test]
    fn keywords_and_colours_are_the_searchs_own_answers() {
        let (conn, deck) = seeded();
        assert_eq!(
            ask(
                &conn,
                deck,
                vec![term(
                    PredicateField::Keyword,
                    PredicateOp::Colon,
                    "flying",
                    false
                )]
            ),
            ["serra"]
        );
        assert_eq!(
            ask(
                &conn,
                deck,
                vec![term(PredicateField::Colors, PredicateOp::Gte, "r", false)]
            ),
            ["bolt-lea", "guide"]
        );
        // A negated name, Scryfall's `-bolt`.
        assert_eq!(
            ask(
                &conn,
                deck,
                vec![term(PredicateField::Name, PredicateOp::Colon, "bolt", true)]
            ),
            ["guide", "serra"]
        );
    }

    /// Only this deck's cards answer — a printing the corpus has and the deck does not is never
    /// in the list, and the theory list is asked beside the live one.
    #[test]
    fn only_this_decks_printings_answer_from_either_list() {
        let (conn, deck) = seeded();
        let instant = || {
            vec![term(
                PredicateField::TypeLine,
                PredicateOp::Colon,
                "instant",
                false,
            )]
        };
        assert_eq!(ask(&conn, deck, instant()), ["bolt-lea"]);
        add(&conn, deck, "bolt-m10", THEORY);
        assert_eq!(ask(&conn, deck, instant()), ["bolt-lea", "bolt-m10"]);
        assert!(ask(&conn, deck + 1, instant()).is_empty());
    }

    /// An oracle tag narrows by the closure, and an exclude keeps what the tag does not reach.
    #[test]
    fn an_oracle_tag_narrows_by_the_closure() {
        let (conn, deck) = seeded();
        conn.execute_batch(
            "INSERT INTO oracle_tag_cards (oracle_id, slug) VALUES ('o1', 'removal');",
        )
        .unwrap();
        let tagged = |include: Vec<String>, exclude: Vec<String>| {
            query_cards(
                &conn,
                deck,
                &CardFilters {
                    oracle_tags: Some(TagTerms { include, exclude }),
                    ..Default::default()
                },
            )
            .unwrap()
        };
        assert_eq!(tagged(vec!["removal".into()], vec![]), ["bolt-lea"]);
        assert_eq!(tagged(vec![], vec!["removal".into()]), ["guide", "serra"]);
    }

    /// An orphan fails a card claim, keeps its set code, and free text is never read here.
    #[test]
    fn an_orphan_answers_its_own_set_code_and_no_card_claim() {
        let (conn, deck) = seeded();
        conn.execute("DELETE FROM cards WHERE id = 'serra'", [])
            .unwrap();
        conn.execute_batch("INSERT INTO cards_fts(cards_fts) VALUES('rebuild');")
            .unwrap();
        assert_eq!(
            ask(
                &conn,
                deck,
                vec![term(
                    PredicateField::TypeLine,
                    PredicateOp::Colon,
                    "creature",
                    false
                )]
            ),
            ["guide"]
        );
        assert_eq!(
            ask(
                &conn,
                deck,
                vec![term(PredicateField::SetCode, PredicateOp::Eq, "lea", false)]
            ),
            ["bolt-lea", "serra"]
        );
        // Free text is the webview's substring test, so a request carrying some is answered as
        // though it carried none.
        let every = query_cards(
            &conn,
            deck,
            &CardFilters {
                text: Some("goblin".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(every, ["bolt-lea", "guide", "serra"]);
    }
}
