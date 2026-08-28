//! What a [`Source`] holds, as [`Card`]s — the one place the mirror asks the database a
//! question.
//!
//! **Composition, not SQL.** Every command in this crate is a thin wrapper over a plain
//! function on `&Connection`, so a mirror pass reads through exactly the three the app's own
//! screens read through: [`crate::deck::get_deck`], [`crate::collection::list_entries`] and
//! [`crate::wishlist::list_wishes`]. A statement written here would be a second answer to
//! "what is in this deck" that nothing keeps in step with the first — and the mirror is the
//! copy a reader falls back on when the app will not open, so it is the last file that may
//! quietly disagree with the screen.
//!
//! **The three row shapes become one, and the conversions are the Rust twins of
//! `src/features/transfer/TransferCard.ts`'s `fromDeckCard` / `fromCollectionRow` /
//! `fromWishRow`.** `null` there means "this surface does not have this fact", never "empty"
//! — see [`Card`] — so every field a surface does not answer stays `None` rather than being
//! filled in from somewhere plausible.

use crate::mirror::layout::Source;
use crate::sorting::Marketplace;
use crate::transfer::Card;
use rusqlite::Connection;

/// Rows per read.
///
/// **500 rather than a larger number, because both list readers clamp.**
/// `collection::MAX_LIMIT` and `wishlist::MAX_LIMIT` are both 500 and both private, so a page
/// asked for at 2 000 comes back holding 500 — which the short-page rule below reads as the
/// end of the list, and a 2 007-row collection would be mirrored as its first 500 rows with
/// nothing raised anywhere. It is the same number `src/features/transfer/export/scope.ts`
/// sweeps at (`SWEEP_PAGE`) and for the same reason: six round trips for a 3 000-card
/// collection instead of thirty, and nothing here is drawing rows, so the page size costs only
/// memory.
///
/// If either clamp is ever lowered this constant has to follow it down, and **there is one test
/// per clamp because there are two constants**:
/// `a_collection_larger_than_one_page_is_read_whole` and
/// `a_wishlist_larger_than_one_page_is_read_whole`.
pub const PAGE: u32 = 500;

/// Every card the source holds, ready to be written to a file.
///
/// **The order is the reader's own** — `read_deck_cards`' category order for a deck, the
/// list's name order for the other two — because a mirror writes files, and a set of files
/// whose lines move about between passes is a diff nobody can read twice.
pub fn cards_for(
    conn: &Connection,
    source: &Source,
    marketplace: Marketplace,
) -> Result<Vec<Card>, String> {
    match *source {
        Source::Deck { id, variant } => {
            let Some(detail) = crate::deck::get_deck(conn, id, variant, marketplace)? else {
                // A deck deleted between the tick that noticed it and this read. Nothing to
                // write is the honest answer; the prune pass is what takes the file away.
                return Ok(Vec::new());
            };
            Ok(detail.cards.iter().map(from_deck_card).collect())
        }
        // **An absent collection `folder_id` is every folder there is**, which is exactly what
        // the whole-collection list wants. See `CollectionQuery::folder_id`, and read it beside
        // `WishlistQuery::folder_id` below — the two surfaces mean opposite things by the same
        // absence.
        //
        // **And `root_only` is deliberately left at its default**, which `collection_cards`'
        // `..Default::default()` gives it: `false`, no folder term pushed, every folder read.
        // That field is the collection page's way of asking the *narrower* question — the root
        // and only the root, with Flatten off — and a whole-collection backup is the one read
        // that must never ask it. Setting it here would mirror a reader's entire collection as
        // the handful of cards they never filed, which is the failure the wishlist arm below
        // avoids from the opposite direction by saying `flatten` out loud.
        Source::WholeCollection => collection_cards(conn, None, marketplace),
        Source::CollectionFolder { id } => collection_cards(conn, Some(id), marketplace),
        // **An absent wishlist `folder_id` is the root, and only the root.** `flatten` is the
        // only field on that surface that says "every folder", so the whole-wishlist read says
        // it explicitly rather than leaving the question unasked — which would silently mirror
        // a reader's whole wishlist as the handful of wishes they never filed.
        Source::WholeWishlist => wishlist_cards(conn, None, true, marketplace),
        Source::WishlistFolder { id } => wishlist_cards(conn, Some(id), false, marketplace),
    }
}

/// The collection, at one folder or across all of them.
///
/// `allocation` is left absent, which is [`crate::collection::Allocation::All`]: the mirror
/// shows the copies a deck holds, because a backup that hid them would be missing cards the
/// reader owns.
fn collection_cards(
    conn: &Connection,
    folder_id: Option<i64>,
    marketplace: Marketplace,
) -> Result<Vec<Card>, String> {
    let mut out = Vec::new();
    let mut offset = 0u32;
    loop {
        let page = crate::collection::list_entries(
            conn,
            &crate::collection::CollectionQuery {
                folder_id,
                marketplace,
                limit: PAGE,
                offset,
                ..Default::default()
            },
        )?;
        let got = page.items.len();
        out.extend(page.items.iter().map(from_collection_row));
        if short_page(got) {
            return Ok(out);
        }
        offset += got as u32;
    }
}

/// The wishlist, at one folder or across all of them.
fn wishlist_cards(
    conn: &Connection,
    folder_id: Option<i64>,
    flatten: bool,
    marketplace: Marketplace,
) -> Result<Vec<Card>, String> {
    let mut out = Vec::new();
    let mut offset = 0u32;
    loop {
        let page = crate::wishlist::list_wishes(
            conn,
            &crate::wishlist::WishlistQuery {
                folder_id,
                flatten,
                marketplace,
                limit: PAGE,
                offset,
                ..Default::default()
            },
        )?;
        let got = page.items.len();
        out.extend(page.items.iter().map(from_wish_row));
        if short_page(got) {
            return Ok(out);
        }
        offset += got as u32;
    }
}

/// Is this the last page?
///
/// **A short page, never the reported total.** A write landing mid-pass moves the total, and
/// believing it either drops the tail (the total shrank) or asks forever for rows past the end
/// (it grew). `src/features/transfer/export/scope.ts` documents the same rule about the same
/// two readers.
fn short_page(got: usize) -> bool {
    got < PAGE as usize
}

/// `'nonfoil'` is the collection's spelling of the regular copy; `None` is everyone else's.
///
/// **Two spellings of one finish fold as two rows and write two lines naming the same card**,
/// which is the whole reason this exists rather than the string being carried through.
/// `TransferCard.ts`'s `finishOf`, verbatim — and a deck row never reaches it holding
/// `"nonfoil"` at all, because `deck::normalise_finish` maps the word away at the command
/// boundary.
fn finish_of(raw: Option<&str>) -> Option<String> {
    match raw {
        Some("foil") => Some("foil".to_owned()),
        Some("etched") => Some("etched".to_owned()),
        _ => None,
    }
}

/// `fromDeckCard`. A deck has piles and labels, and no purchase history at all.
fn from_deck_card(row: &crate::deck::DeckCardRow) -> Card {
    Card {
        name: row.name.clone(),
        quantity: row.quantity,
        set_code: Some(row.set_code.clone()),
        collector_number: Some(row.collector_number.clone()),
        finish: finish_of(row.finish.as_deref()),
        lang: Some(row.lang.clone()),
        category_name: Some(row.category_name.clone()),
        category_kind: Some(row.category_kind.clone()),
        category_active: Some(row.category_active),
        condition: None,
        tradelist_quantity: None,
        purchase_price: None,
        purchase_currency: None,
        acquired_at: None,
        acquisition_source: None,
        serial_number: None,
        grading: None,
        altered: None,
        signed: None,
        proxy: None,
        misprint: None,
        tags: None,
        notes: None,
        set_name: row.set_name.clone(),
        rarity: row.rarity.clone(),
        type_line: row.type_line.clone(),
        unit_price: row.unit_price,
        // The one surface that has a label, and `deck_get` carries both halves on the row, so
        // this costs no second read.
        tag_name: row.tag_name.clone(),
        tag_color: row.tag_color.clone(),
        legalities: row.legalities.clone(),
    }
}

/// `fromCollectionRow`. The only surface with provenance — condition, price, grading, notes.
fn from_collection_row(row: &crate::collection::CollectionRow) -> Card {
    Card {
        // `""` where the printing has left `cards`, which is `fromCollectionRow`'s own
        // `row.name ?? ""`: the row is still a card the reader owns and still belongs in the
        // file. Only this surface needs the fallback — a deck card and a wish each carry a
        // denormalised name of their own.
        name: row.name.clone().unwrap_or_default(),
        quantity: row.quantity,
        set_code: Some(row.set_code.clone()),
        collector_number: Some(row.collector_number.clone()),
        finish: finish_of(Some(row.finish.as_str())),
        lang: Some(row.lang.clone()),
        category_name: None,
        category_kind: None,
        category_active: None,
        condition: Some(row.condition.clone()),
        tradelist_quantity: Some(row.tradelist_quantity),
        purchase_price: row.purchase_price,
        purchase_currency: row.purchase_currency.clone(),
        acquired_at: row.acquired_at.clone(),
        acquisition_source: row.acquisition_source.clone(),
        serial_number: row.serial_number.clone(),
        grading: row.grading.clone(),
        altered: Some(row.altered),
        signed: Some(row.signed),
        proxy: Some(row.proxy),
        misprint: Some(row.misprint),
        // The reader's own free text on a copy they own — **not** a deck label. No surface has
        // both, which is why the two can never appear in one file.
        tags: Some(row.tags.clone()),
        notes: row.notes.clone(),
        set_name: row.set_name.clone(),
        rarity: row.rarity.clone(),
        type_line: row.type_line.clone(),
        unit_price: row.unit_price,
        tag_name: None,
        tag_color: None,
        legalities: row.legalities.clone(),
    }
}

/// `fromWishRow`. A wish names a card and a finish and almost nothing else.
fn from_wish_row(row: &crate::wishlist::WishRow) -> Card {
    Card {
        name: row.name.clone(),
        quantity: row.quantity,
        set_code: row.set_code.clone(),
        collector_number: row.collector_number.clone(),
        // **A wish's finish is `preferred_finish`**, the one field name that differs from the
        // other two surfaces' — and an absent one means "any printing will do" rather than
        // "the regular copy", which reaches the file as the same blank either way.
        finish: finish_of(row.preferred_finish.as_deref()),
        lang: row.lang.clone(),
        category_name: None,
        category_kind: None,
        category_active: None,
        condition: None,
        tradelist_quantity: None,
        purchase_price: None,
        purchase_currency: None,
        acquired_at: None,
        acquisition_source: None,
        serial_number: None,
        grading: None,
        altered: None,
        signed: None,
        proxy: None,
        misprint: None,
        tags: None,
        notes: row.notes.clone(),
        // Deliberately not `row.set_code`'s neighbour: a wish's `LEFT JOIN` answers a printing
        // to *draw*, and `fromWishRow` carries no set name. The blank is the surface saying it
        // does not have the fact.
        set_name: None,
        rarity: row.rarity.clone(),
        type_line: row.type_line.clone(),
        unit_price: row.unit_price,
        tag_name: None,
        tag_color: None,
        legalities: row.legalities.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A database with the two printings every fixture below files copies of.
    ///
    /// **Seeding `cards` is allowed here and nowhere else in this module's neighbourhood**:
    /// the connection is in memory and dies with the test, so no later measurement of the
    /// real corpus can be made a fiction by it. Every fixture goes through the app's own
    /// write commands from there — a hand-written `collection_entries` row would be a grain
    /// this crate never produces and a test about nothing.
    fn seeded() -> Connection {
        let conn = crate::schema::memory_pair();
        for (id, oracle, name, set, num) in [
            ("bolt-lea", "o1", "Lightning Bolt", "lea", "161"),
            ("sol-lea", "o2", "Sol Ring", "lea", "263"),
        ] {
            conn.execute(
                "INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                    rarity,type_line,finishes,prices,raw)
                 VALUES (?1,?2,?3,?4,?5,'en','normal','common','Instant',
                    '[\"nonfoil\",\"foil\"]','{\"usd\":\"1.00\"}','{}')",
                rusqlite::params![id, oracle, name, set, num],
            )
            .unwrap();
        }
        conn
    }

    /// The default marketplace, spelled once. Which prices a mirror quotes is not what any
    /// test here is about.
    fn shop() -> Marketplace {
        Marketplace::default()
    }

    fn entry(card_id: &str, finish: &str, folder_id: Option<i64>) -> crate::collection::EntryInput {
        crate::collection::EntryInput {
            card_id: card_id.to_owned(),
            finish: finish.to_owned(),
            quantity: 1,
            folder_id,
            ..Default::default()
        }
    }

    fn wish(card_id: &str, folder_id: Option<i64>) -> crate::wishlist::WishInput {
        crate::wishlist::WishInput {
            card_id: Some(card_id.to_owned()),
            quantity: 1,
            folder_id,
            ..Default::default()
        }
    }

    /// One deck, one card sleeved up and two in the plan.
    fn db_with_deck_holding_live_and_theory_rows() -> (Connection, i64) {
        let conn = seeded();
        let deck = crate::deck::create_deck(
            &conn,
            &crate::deck::DeckInput {
                name: "Burn".to_owned(),
                ..Default::default()
            },
        )
        .unwrap();
        crate::deck::add_card(
            &conn,
            deck.id,
            "bolt-lea",
            None,
            Some("Main"),
            "live",
            None,
            4,
        )
        .unwrap();
        crate::deck::add_card(
            &conn,
            deck.id,
            "bolt-lea",
            None,
            Some("Main"),
            "theory",
            None,
            4,
        )
        .unwrap();
        crate::deck::add_card(
            &conn,
            deck.id,
            "sol-lea",
            None,
            Some("Ramp"),
            "theory",
            None,
            1,
        )
        .unwrap();
        (conn, deck.id)
    }

    /// Two copies, one at the root and one in a binder. Answers the binder's id, which is
    /// **not** 1: schema v25 files `Recently removed` before any reader can make a folder,
    /// so a hard-coded id here would be testing the app's own holding area.
    fn db_with_two_entries_one_filed() -> (Connection, i64) {
        let conn = seeded();
        let binder = crate::collection_folders::create_folder(&conn, None, "Binder").unwrap();
        crate::collection::add_entry(&conn, &entry("bolt-lea", "nonfoil", None)).unwrap();
        crate::collection::add_entry(&conn, &entry("sol-lea", "nonfoil", Some(binder.id))).unwrap();
        (conn, binder.id)
    }

    /// Two wishes, one at the root and one filed.
    fn db_with_two_wishes_one_filed() -> (Connection, i64) {
        let conn = seeded();
        let ordered = crate::wishlist_folders::create_folder(&conn, None, "Ordered").unwrap();
        crate::wishlist::add_wish(&conn, &wish("bolt-lea", None)).unwrap();
        crate::wishlist::add_wish(&conn, &wish("sol-lea", Some(ordered.id))).unwrap();
        (conn, ordered.id)
    }

    fn db_with_a_nonfoil_entry() -> Connection {
        let conn = seeded();
        crate::collection::add_entry(&conn, &entry("bolt-lea", "nonfoil", None)).unwrap();
        conn
    }

    /// `n` collection rows of one printing, told apart by serial number — the ninth term of
    /// [`crate::schema::COLLECTION_GRAIN`], and much cheaper than `n` printings.
    fn db_with_n_entries(n: u32) -> Connection {
        let conn = seeded();
        for i in 0..n {
            crate::collection::add_entry(
                &conn,
                &crate::collection::EntryInput {
                    serial_number: Some(format!("{i}/{n}")),
                    ..entry("bolt-lea", "nonfoil", None)
                },
            )
            .unwrap();
        }
        conn
    }

    #[test]
    fn a_deck_source_answers_the_variant_it_names() {
        let (conn, id) = db_with_deck_holding_live_and_theory_rows();
        let live = cards_for(
            &conn,
            &Source::Deck {
                id,
                variant: "live",
            },
            shop(),
        )
        .unwrap();
        let theory = cards_for(
            &conn,
            &Source::Deck {
                id,
                variant: "theory",
            },
            shop(),
        )
        .unwrap();
        assert_eq!(live.len(), 1);
        assert_eq!(theory.len(), 2);
        // The variant really is the thing being read, not the row count: the plan holds a
        // card the sleeved list does not.
        assert!(theory.iter().any(|c| c.name == "Sol Ring"));
        assert!(!live.iter().any(|c| c.name == "Sol Ring"));
    }

    #[test]
    fn a_deck_that_is_gone_is_no_cards_rather_than_an_error() {
        let conn = seeded();
        let cards = cards_for(
            &conn,
            &Source::Deck {
                id: 404,
                variant: "live",
            },
            shop(),
        )
        .unwrap();
        assert!(cards.is_empty());
    }

    #[test]
    fn the_whole_collection_means_every_folder_and_a_folder_means_its_direct_members() {
        let (conn, binder) = db_with_two_entries_one_filed();
        let all = cards_for(&conn, &Source::WholeCollection, shop()).unwrap();
        let filed = cards_for(&conn, &Source::CollectionFolder { id: binder }, shop()).unwrap();
        assert_eq!(
            all.len(),
            2,
            "an absent collection folder_id is every folder"
        );
        assert_eq!(filed.len(), 1);
        assert_eq!(filed[0].name, "Sol Ring");
    }

    #[test]
    fn the_whole_wishlist_means_every_folder_which_on_this_surface_takes_flatten() {
        let (conn, ordered) = db_with_two_wishes_one_filed();
        let all = cards_for(&conn, &Source::WholeWishlist, shop()).unwrap();
        assert_eq!(
            all.len(),
            2,
            "an absent wishlist folder_id is the ROOT — flatten is what says every folder"
        );
        // The other end of the same asymmetry: a *named* folder is that folder alone, which is
        // what `flatten: false` is for. Without this the arm above could be satisfied by a
        // read that flattened everything unconditionally.
        let filed = cards_for(&conn, &Source::WishlistFolder { id: ordered }, shop()).unwrap();
        assert_eq!(filed.len(), 1);
        assert_eq!(filed[0].name, "Sol Ring");
    }

    #[test]
    fn nonfoil_is_the_regular_copy_and_not_a_third_finish() {
        let conn = db_with_a_nonfoil_entry();
        let cards = cards_for(&conn, &Source::WholeCollection, shop()).unwrap();
        assert_eq!(
            cards[0].finish, None,
            "two spellings of one finish would write two lines"
        );
    }

    /// `n` wishes, told apart by the printing they name — [`crate::schema::WISHLIST_GRAIN`]'s
    /// second term, and the only one of its four a fixture can vary `n` times cheaply. A serial
    /// number is not in this grain, so the collection's trick does not port.
    fn db_with_n_wishes(n: u32) -> Connection {
        let conn = seeded();
        for i in 0..n {
            let id = format!("bolt-{i}");
            conn.execute(
                "INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                    rarity,type_line,finishes,prices,raw)
                 VALUES (?1,'o1','Lightning Bolt','lea',?2,'en','normal','common','Instant',
                    '[\"nonfoil\",\"foil\"]','{\"usd\":\"1.00\"}','{}')",
                rusqlite::params![id, i.to_string()],
            )
            .unwrap();
            crate::wishlist::add_wish(&conn, &wish(&id, None)).unwrap();
        }
        conn
    }

    /// **[`PAGE`] is correct only because both list readers clamp at the same number, and
    /// neither clamp is public.** Lowering `collection::MAX_LIMIT` is caught by the test below;
    /// lowering `wishlist::MAX_LIMIT` alone was caught by nothing at all, and would have
    /// mirrored every wishlist as its first 500 rows with no error raised anywhere. The two
    /// halves need two tests because they are two constants.
    #[test]
    fn a_wishlist_larger_than_one_page_is_read_whole() {
        let conn = db_with_n_wishes(PAGE + 7);
        let cards = cards_for(&conn, &Source::WholeWishlist, shop()).unwrap();
        assert_eq!(cards.len() as u32, PAGE + 7);
    }

    #[test]
    fn a_collection_larger_than_one_page_is_read_whole() {
        let conn = db_with_n_entries(PAGE + 7);
        let cards = cards_for(&conn, &Source::WholeCollection, shop()).unwrap();
        assert_eq!(cards.len() as u32, PAGE + 7);
    }

    /// **Each surface answers only the facts it has, and a `None` here is that statement.**
    /// The three conversions are field-for-field ports and the way they rot is a field being
    /// filled in from somewhere plausible — a deck growing a `condition` of `"NM"`, a
    /// collection row growing a pile name — which draws a column of nonsense in every
    /// mirrored CSV and nothing red anywhere.
    #[test]
    fn a_surface_answers_only_the_facts_it_has() {
        let (deck_conn, id) = db_with_deck_holding_live_and_theory_rows();
        let deck = cards_for(
            &deck_conn,
            &Source::Deck {
                id,
                variant: "live",
            },
            shop(),
        )
        .unwrap();
        assert_eq!(deck[0].category_name.as_deref(), Some("Main"));
        assert_eq!(deck[0].category_kind.as_deref(), Some("main"));
        assert_eq!(deck[0].category_active, Some(true));
        assert_eq!(deck[0].quantity, 4);
        assert_eq!(deck[0].set_code.as_deref(), Some("lea"));
        assert_eq!(deck[0].condition, None, "a deck has no condition");
        assert_eq!(deck[0].tags, None, "a deck has no free-text tags");

        let (col_conn, _) = db_with_two_entries_one_filed();
        let collection = cards_for(&col_conn, &Source::WholeCollection, shop()).unwrap();
        assert_eq!(collection[0].condition.as_deref(), Some("NM"));
        assert_eq!(collection[0].tradelist_quantity, Some(0));
        // `'[]'` and not `''`: the column is a JSON array of the reader's own words, and its
        // default is the empty array. Worth pinning, because the field beside it on a deck row
        // is a *label* and the two are one field apart.
        assert_eq!(collection[0].tags.as_deref(), Some("[]"));
        assert_eq!(collection[0].category_name, None, "a binder has no piles");
        assert_eq!(collection[0].tag_name, None, "a binder has no deck labels");

        let (wish_conn, _) = db_with_two_wishes_one_filed();
        let wishes = cards_for(&wish_conn, &Source::WholeWishlist, shop()).unwrap();
        assert_eq!(wishes[0].quantity, 1);
        assert_eq!(wishes[0].condition, None, "a wish has no condition");
        assert_eq!(wishes[0].category_name, None, "a wish has no piles");
        assert_eq!(wishes[0].set_name, None, "a wish carries no set name");
    }

    /// A foil wish reaches the file as `"foil"` and a wish that names no finish as nothing —
    /// and the field it is read from is `preferred_finish`, which is the one name that
    /// differs from the other two surfaces'.
    #[test]
    fn a_wishs_finish_comes_from_preferred_finish() {
        let conn = seeded();
        crate::wishlist::add_wish(
            &conn,
            &crate::wishlist::WishInput {
                preferred_finish: Some("foil".to_owned()),
                ..wish("bolt-lea", None)
            },
        )
        .unwrap();
        crate::wishlist::add_wish(&conn, &wish("sol-lea", None)).unwrap();
        let cards = cards_for(&conn, &Source::WholeWishlist, shop()).unwrap();
        let of = |name: &str| {
            cards
                .iter()
                .find(|c| c.name == name)
                .unwrap_or_else(|| panic!("no wish for {name}"))
        };
        assert_eq!(of("Lightning Bolt").finish.as_deref(), Some("foil"));
        assert_eq!(of("Sol Ring").finish, None);
    }
}
