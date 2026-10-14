use super::*;
use rusqlite::{params, Connection};

/// `collection_folders.rs`'s own `open()`, which is private to that module's tests — so this is
/// the same two lines rather than a call into it.
///
/// **`foreign_keys` is ON and that is not ceremony here**: `collection_entries.folder_id`
/// REFERENCES `collection_folders`, and an in-memory connection starts with the pragma off, so
/// without this line a test could file a card in a folder that does not exist and pass.
/// [`crate::schema::memory_pair`] already sets it; saying so again is what makes that a
/// property of this fixture rather than of a helper three thousand lines away.
fn test_db() -> Connection {
    let conn = crate::schema::memory_pair();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    conn
}

/// The `Recently removed` folder [`crate::schema::memory_pair`]'s seed already inserted.
///
/// **A test may not insert a second one**: `idx_collection_folder_removed` is
/// `UNIQUE (kind) WHERE kind = 'removed'`, so a fixture that files its own would fail on the
/// insert rather than on the assertion it was written for.
fn seeded_removed_folder(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT id FROM collection_folders WHERE kind = 'removed'",
        [],
        |r| r.get(0),
    )
    .unwrap()
}

/// A deck and the group folder that stands for it — the other `kind` a share must never carry.
/// The `CHECK ((kind = 'deck') = (deck_id IS NOT NULL))` is why the deck row has to exist.
fn deck_group(conn: &Connection, name: &str) -> i64 {
    conn.execute(
        "INSERT INTO decks (name, created_at, updated_at) VALUES (?1, 0, 0)",
        params![name],
    )
    .unwrap();
    let deck = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO collection_folders
           (parent_id, name, kind, deck_id, sort_order, created_at, updated_at, sync_uid, locked)
         VALUES (NULL, ?1, 'deck', ?2, 0, 0, 0, ?3, 0)",
        params![name, deck, format!("uid-deck-{name}")],
    )
    .unwrap();
    conn.last_insert_rowid()
}

fn folder(
    conn: &rusqlite::Connection,
    parent: Option<i64>,
    name: &str,
    locked: bool,
) -> (i64, String) {
    let uid = format!("uid-{name}");
    conn.execute(
        "INSERT INTO collection_folders
           (parent_id, name, kind, sort_order, created_at, updated_at, sync_uid, locked)
         VALUES (?1, ?2, 'user', 0, 0, 0, ?3, ?4)",
        params![parent, name, uid, i64::from(locked)],
    )
    .unwrap();
    (conn.last_insert_rowid(), uid)
}

/// The `display` URL the corpus stores for `id`, in Scryfall's own shape.
///
/// **`display` and not `normal`**: [`crate::image_uri::FRONT_FACE_VARIANT`] is the key
/// `front_face_selects` reads, so a fixture keyed on anything else makes every `img` in every
/// snapshot silently absent — and the size measurement below a fiction.
fn display_uri(id: &str) -> String {
    let mut chars = id.chars();
    let a = chars.next().unwrap_or('0');
    let b = chars.next().unwrap_or('0');
    format!("https://cards.scryfall.io/display/front/{a}/{b}/{id}.webp?1757308800")
}

fn card(conn: &rusqlite::Connection, id: &str, name: &str) {
    conn.execute(
        "INSERT INTO cards (id, name, set_code, collector_number, lang, layout, raw,
                            image_uris, prices)
         VALUES (?1, ?2, 'tsp', '157', 'en', 'normal', '{}',
                 json_object('display', ?3),
                 json_object('usd', '0.34'))",
        params![id, name, display_uri(id)],
    )
    .unwrap();
}

/// **Every private column carries a distinctive value, and that is what makes
/// [`no_private_field_can_reach_the_wire`] a real sweep.** A column left unset is a column that
/// test fences by *key name* only — and a key name is the half a `#[serde(rename)]` or a short
/// key like `p` would not carry anyway. So the four text columns spec §3 names, the two the
/// grain adds and the free-text `tags` all hold a `private-…` marker here, and the string sweep
/// looks for each. The four booleans (`altered`, `signed`, `proxy`, `misprint`) are set to 1 so
/// the columns are non-default, but a `1` is not distinctive and only their key names are swept.
///
/// ⚠️ **Two text columns were unset here until 2026-09-08, and both are exactly the shape the
/// paragraph above is about.** `needs_review` is a **free-text sentence** the reconciler writes —
/// *"the printing vanished from Scryfall"*, and a reader's own row can carry any of them — and it
/// was NULL on every row this fixture made, so a leak under a short key would have serialised as
/// `null` and passed both halves of the sweep. `condition_original` is arbitrary text off the
/// reader's own **import file**, so its content is whatever their spreadsheet held, and it was on
/// neither spec §3 list nor either half of the sweep. Both carry a marker now.
fn entry(conn: &rusqlite::Connection, card_id: &str, folder: Option<i64>, qty: i64) {
    conn.execute(
        "INSERT INTO collection_entries
           (card_id, set_code, collector_number, lang, finish, condition, condition_original,
            quantity, tradelist_quantity, purchase_price, purchase_currency, acquired_at,
            acquisition_source, notes, tags, serial_number, grading,
            altered, signed, proxy, misprint, needs_review, folder_id, created_at, updated_at)
         VALUES (?1, 'tsp', '157', 'en', 'nonfoil', 'NM', 'private-graded-GD',
                 ?2, 7, 9.99,
                 'private-currency-DKK', 'private-acquired-2019-08-02',
                 'private-source GP Copenhagen', 'private-notes bought at a GP',
                 '[\"private-tag\"]', 'private-serial-042/500',
                 '{\"company\":\"private-grader\",\"grade\":10}',
                 1, 1, 1, 1, 'private-review this printing left Scryfall',
                 ?3, 0, 0)",
        params![card_id, qty, folder],
    )
    .unwrap();
}

fn all(condition: bool) -> ShareFields {
    ShareFields {
        condition,
        lang: condition,
        value: condition,
    }
}

fn snap(conn: &rusqlite::Connection, folder_uid: Option<&str>) -> ShareSnapshot {
    snapshot(
        conn,
        "testshareid00000",
        "Giradeli",
        folder_uid,
        all(true),
        crate::sorting::Marketplace::Tcgplayer,
        1_757_308_800,
    )
    .unwrap()
}

#[test]
fn a_shared_parent_carries_its_subfolders_cards() {
    let conn = test_db();
    let (parent, parent_uid) = folder(&conn, None, "Binder", false);
    let (child, _) = folder(&conn, Some(parent), "Duals", false);
    card(&conn, "c1", "Fury Sliver");
    card(&conn, "c2", "Tundra");
    entry(&conn, "c1", Some(parent), 1);
    entry(&conn, "c2", Some(child), 2);

    let s = snap(&conn, Some(&parent_uid));

    let names: Vec<&str> = s.cards.iter().map(|c| c.n.as_str()).collect();
    assert!(
        names.contains(&"Tundra"),
        "the subfolder's card must travel: {names:?}"
    );
    assert_eq!(
        s.folders.len(),
        2,
        "both folders travel so the viewer can draw the tree"
    );
}

#[test]
fn a_locked_subfolder_is_dropped_from_its_parents_share() {
    let conn = test_db();
    let (parent, parent_uid) = folder(&conn, None, "Binder", false);
    let (locked, _) = folder(&conn, Some(parent), "Display case", true);
    card(&conn, "c1", "Fury Sliver");
    card(&conn, "c2", "Black Lotus");
    entry(&conn, "c1", Some(parent), 1);
    entry(&conn, "c2", Some(locked), 1);

    let s = snap(&conn, Some(&parent_uid));

    let names: Vec<&str> = s.cards.iter().map(|c| c.n.as_str()).collect();
    assert_eq!(
        names,
        vec!["Fury Sliver"],
        "a locked subfolder must not travel"
    );
    assert_eq!(s.folders.len(), 1, "and neither must its name");
}

#[test]
fn a_folder_below_a_locked_one_is_dropped_too() {
    let conn = test_db();
    let (parent, parent_uid) = folder(&conn, None, "Binder", false);
    let (locked, _) = folder(&conn, Some(parent), "Display case", true);
    let (under, _) = folder(&conn, Some(locked), "Top shelf", false);
    card(&conn, "c1", "Black Lotus");
    entry(&conn, "c1", Some(under), 1);

    let s = snap(&conn, Some(&parent_uid));

    assert!(
        s.cards.is_empty(),
        "the lock inherits down, so this card is set aside too"
    );
}

#[test]
fn publishing_a_locked_folder_is_refused_by_name() {
    let conn = test_db();
    let (_, uid) = folder(&conn, None, "Display case", true);
    let err = snapshot(
        &conn,
        "x",
        "Giradeli",
        Some(&uid),
        all(false),
        crate::sorting::Marketplace::Tcgplayer,
        0,
    )
    .unwrap_err();
    assert_eq!(err, FOLDER_IS_LOCKED);
}

/// The **inherited** lock, which is the half that fails quietly if `effectively_locked` ever
/// becomes a plain `locked <> 0`. `SUBTREE` would drop the folder on its own, `ids` would come
/// back empty, and the caller would get a perfectly valid **empty snapshot** — spec §4's named
/// failure, "uploading an empty snapshot that reads as *this person owns nothing*". The refusal
/// is what must survive, not merely the exclusion.
#[test]
fn an_unlocked_folder_under_a_locked_one_is_refused_rather_than_published_empty() {
    let conn = test_db();
    let (locked, _) = folder(&conn, None, "Display case", true);
    let (child, child_uid) = folder(&conn, Some(locked), "Top shelf", false);
    card(&conn, "c1", "Black Lotus");
    entry(&conn, "c1", Some(child), 1);

    let err = snapshot(
        &conn,
        "x",
        "Giradeli",
        Some(&child_uid),
        all(false),
        crate::sorting::Marketplace::Tcgplayer,
        0,
    )
    .unwrap_err();
    assert_eq!(err, FOLDER_IS_LOCKED);
}

/// A folder that is not there is refused by name, before anything is read.
#[test]
fn a_missing_folder_is_refused_by_name() {
    let conn = test_db();
    let err = snapshot(
        &conn,
        "x",
        "Giradeli",
        Some("uid-nobody"),
        all(false),
        crate::sorting::Marketplace::Tcgplayer,
        0,
    )
    .unwrap_err();
    assert_eq!(err, FOLDER_NOT_FOUND);
}

/// **Issue #941: a deck's group and `Recently removed` are shareable when named.** Each is
/// published whole, under its own name, and carries nothing from anywhere else.
#[test]
fn a_named_deck_group_and_recently_removed_each_travel() {
    let conn = test_db();
    let removed = seeded_removed_folder(&conn);
    let group = deck_group(&conn, "Krenko");
    card(&conn, "c1", "Fury Sliver");
    card(&conn, "c2", "Goblin Recruiter");
    card(&conn, "c3", "Tundra");
    entry(&conn, "c1", Some(removed), 1);
    entry(&conn, "c2", Some(group), 1);
    entry(&conn, "c3", None, 1);

    let s = snap(&conn, Some("uid-deck-Krenko"));
    assert_eq!(s.title, "Krenko");
    let names: Vec<&str> = s.cards.iter().map(|c| c.n.as_str()).collect();
    assert_eq!(names, vec!["Goblin Recruiter"]);
    assert_eq!(s.folders.len(), 1);
    assert_eq!(s.folders[0].parent, None);

    let removed_uid: String = conn
        .query_row(
            "SELECT sync_uid FROM collection_folders WHERE id = ?1",
            params![removed],
            |r| r.get(0),
        )
        .unwrap();
    let s = snap(&conn, Some(&removed_uid));
    assert_eq!(s.title, "Recently removed");
    let names: Vec<&str> = s.cards.iter().map(|c| c.n.as_str()).collect();
    assert_eq!(names, vec!["Fury Sliver"]);
}

/// A locked deck group is still refused — the lock is the reader's, whatever the folder's kind.
#[test]
fn a_locked_deck_group_is_refused() {
    let conn = test_db();
    let group = deck_group(&conn, "Krenko");
    conn.execute(
        "UPDATE collection_folders SET locked = 1 WHERE id = ?1",
        params![group],
    )
    .unwrap();
    let err = snapshot(
        &conn,
        "x",
        "Giradeli",
        Some("uid-deck-Krenko"),
        all(false),
        crate::sorting::Marketplace::Tcgplayer,
        0,
    )
    .unwrap_err();
    assert_eq!(err, FOLDER_IS_LOCKED);
}

/// **The unasked question still publishes less.** A whole-collection share leaves the app's own
/// folders out, so a share made before #941 does not grow by every deck on its next refresh.
#[test]
fn a_whole_collection_share_still_leaves_deck_groups_and_recently_removed_out() {
    let conn = test_db();
    // **The seeded row, not a second one.** `idx_collection_folder_removed` permits exactly one
    // `removed` folder per database and `memory_pair` already inserted it.
    let removed = seeded_removed_folder(&conn);
    let group = deck_group(&conn, "Krenko");
    card(&conn, "c1", "Fury Sliver");
    card(&conn, "c2", "Goblin Recruiter");
    entry(&conn, "c1", Some(removed), 1);
    entry(&conn, "c2", Some(group), 1);

    let s = snap(&conn, None);

    assert!(
        s.cards.is_empty(),
        "an app-owned folder travels only when named"
    );
    assert!(s.folders.is_empty());
}

/* --------------------------------------------------------------- wishlists (#941) -------- */

fn wish_folder(conn: &Connection, parent: Option<i64>, name: &str, uid: Option<&str>) -> i64 {
    conn.execute(
        "INSERT INTO wishlist_folders (parent_id, name, sort_order, created_at, updated_at, sync_uid)
         VALUES (?1, ?2, 0, 0, 0, ?3)",
        params![parent, name, uid],
    )
    .unwrap();
    conn.last_insert_rowid()
}

/// A theory deck with a managed wishlist folder and its Tokens child, both with **no** uid — the
/// shape `crate::managed_wishlist` leaves, since it writes under `capture::suppressed`.
fn managed(conn: &Connection, deck: &str) -> (i64, i64) {
    conn.execute(
        "INSERT INTO decks (name, created_at, updated_at, sync_uid) VALUES (?1, 0, 0, ?2)",
        params![deck, format!("deckuid-{deck}")],
    )
    .unwrap();
    let deck_id = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO wishlist_folders
           (parent_id, name, sort_order, created_at, updated_at, managed_deck_id, managed_tokens)
         VALUES (NULL, ?1, 0, 0, 0, ?2, 0)",
        params![deck, deck_id],
    )
    .unwrap();
    let own = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO wishlist_folders
           (parent_id, name, sort_order, created_at, updated_at, managed_deck_id, managed_tokens)
         VALUES (?1, 'Tokens', 0, 0, 0, ?2, 1)",
        params![own, deck_id],
    )
    .unwrap();
    (own, conn.last_insert_rowid())
}

/// One wish, with a private marker in both free-text columns. `card_id` `None` is any printing.
fn wish(
    conn: &Connection,
    card_id: Option<&str>,
    oracle: &str,
    folder: Option<i64>,
    finish: Option<&str>,
) {
    conn.execute(
        "INSERT INTO wishlist_entries
           (oracle_id, card_id, name, quantity, preferred_finish, notes, needs_review,
            created_at, updated_at, folder_id)
         VALUES (?1, ?2, 'Wished-for name', 2, ?3, 'private-wish-note', 'private-wish-review',
                 0, 0, ?4)",
        params![oracle, card_id, finish, folder],
    )
    .unwrap();
}

fn oracle(conn: &Connection, card: &str, oracle: &str) {
    conn.execute(
        "UPDATE cards SET oracle_id = ?2 WHERE id = ?1",
        params![card, oracle],
    )
    .unwrap();
}

#[test]
fn wishlist_keys_parse_into_their_four_shapes() {
    use super::wishlist::WishlistKey;
    use super::wishlist::WishlistKey::*;
    assert_eq!(WishlistKey::parse("wishlist:"), Some(Ok(Whole)));
    assert_eq!(
        WishlistKey::parse("wishlist:folder:abc"),
        Some(Ok(Folder("abc")))
    );
    assert_eq!(
        WishlistKey::parse("wishlist:deck:abc"),
        Some(Ok(Deck("abc")))
    );
    assert_eq!(
        WishlistKey::parse("wishlist:deck-tokens:abc"),
        Some(Ok(DeckTokens("abc")))
    );
    assert_eq!(WishlistKey::parse("wishlist:folder:"), Some(Err(())));
    assert_eq!(WishlistKey::parse("wishlist:later-shape:x"), Some(Err(())));
    assert_eq!(WishlistKey::parse("0123456789abcdef0123456789abcdef"), None);
}

/// The whole wishlist: the root and the reader's own folders, never a managed one.
#[test]
fn a_whole_wishlist_share_carries_the_root_and_the_readers_folders() {
    let conn = test_db();
    card(&conn, "c1", "Fury Sliver");
    card(&conn, "c2", "Tundra");
    card(&conn, "c3", "Goblin Recruiter");
    let buy = wish_folder(&conn, None, "Buy list", Some("wuid-buy"));
    let (deck_folder, _) = managed(&conn, "Krenko");
    wish(&conn, Some("c1"), "o1", None, None);
    wish(&conn, Some("c2"), "o2", Some(buy), Some("foil"));
    wish(&conn, Some("c3"), "o3", Some(deck_folder), None);

    let s = snap(&conn, Some("wishlist:"));

    assert_eq!(s.title, WHOLE_WISHLIST_TITLE);
    assert_eq!(WHOLE_WISHLIST_TITLE, "Wishlist");
    let names: Vec<&str> = s.cards.iter().map(|c| c.n.as_str()).collect();
    assert_eq!(names, vec!["Fury Sliver", "Tundra"]);
    let tundra = &s.cards[1];
    assert_eq!(tundra.f, "foil");
    assert_eq!(tundra.q, 2);
    assert_eq!(tundra.fo.as_deref(), Some("wuid-buy"));
    assert_eq!(s.cards[0].f, "nonfoil", "no preference is the regular copy");
    assert!(
        s.cards.iter().all(|c| c.c.is_none()),
        "a wish has no condition"
    );
    assert!(!s.fields.contains(&"condition"));
    assert_eq!(s.folders.len(), 1);
    assert_eq!(s.folders[0].uid, "wuid-buy");
}

/// A deck's managed wishlist, by the deck's uid: its folder and its Tokens child, and the child
/// alone under its own key. The folders have no uid of their own and still travel.
#[test]
fn a_managed_wishlist_is_shared_by_its_decks_uid() {
    let conn = test_db();
    card(&conn, "c1", "Goblin Recruiter");
    card(&conn, "t1", "Goblin");
    let (own, tokens) = managed(&conn, "Krenko");
    wish(&conn, Some("c1"), "o1", Some(own), None);
    wish(&conn, Some("t1"), "ot", Some(tokens), None);

    let s = snap(&conn, Some("wishlist:deck:deckuid-Krenko"));
    assert_eq!(s.title, "Krenko");
    let names: Vec<&str> = s.cards.iter().map(|c| c.n.as_str()).collect();
    assert_eq!(names, vec!["Goblin", "Goblin Recruiter"]);
    assert_eq!(s.folders.len(), 2);
    let root = s.folders.iter().find(|f| f.name == "Krenko").unwrap();
    let child = s.folders.iter().find(|f| f.name == "Tokens").unwrap();
    assert_eq!(root.parent, None);
    assert_eq!(child.parent.as_deref(), Some(root.uid.as_str()));
    assert_eq!(
        root.uid.len(),
        32,
        "a minted uid, never a row id: {}",
        root.uid
    );

    let s = snap(&conn, Some("wishlist:deck-tokens:deckuid-Krenko"));
    assert_eq!(s.title, "Krenko tokens");
    let names: Vec<&str> = s.cards.iter().map(|c| c.n.as_str()).collect();
    assert_eq!(names, vec!["Goblin"]);
}

/// A folder the reader made, by its own uid — the root stays home.
#[test]
fn a_wishlist_folder_share_carries_its_subtree_and_not_the_root() {
    let conn = test_db();
    card(&conn, "c1", "Fury Sliver");
    card(&conn, "c2", "Tundra");
    let buy = wish_folder(&conn, None, "Buy list", Some("wuid-buy"));
    let inner = wish_folder(&conn, Some(buy), "Soon", Some("wuid-soon"));
    wish(&conn, Some("c1"), "o1", None, None);
    wish(&conn, Some("c2"), "o2", Some(inner), None);

    let s = snap(&conn, Some("wishlist:folder:wuid-buy"));
    assert_eq!(s.title, "Buy list");
    let names: Vec<&str> = s.cards.iter().map(|c| c.n.as_str()).collect();
    assert_eq!(names, vec!["Tundra"]);
    let soon = s.folders.iter().find(|f| f.uid == "wuid-soon").unwrap();
    assert_eq!(soon.parent.as_deref(), Some("wuid-buy"));
}

/// An any-printing wish is drawn as a real printing of its card, so a viewer has art and a set.
#[test]
fn an_any_printing_wish_travels_as_a_printing_of_its_card() {
    let conn = test_db();
    card(&conn, "c1", "Fury Sliver");
    oracle(&conn, "c1", "o1");
    wish(&conn, None, "o1", None, None);

    let s = snap(&conn, Some("wishlist:"));
    assert_eq!(s.cards.len(), 1);
    assert_eq!(s.cards[0].id, "c1");
    assert_eq!(s.cards[0].s, "tsp");
    assert_eq!(s.cards[0].cn, "157");
    assert!(s.cards[0].img.is_some());
    assert_eq!(s.cards[0].p, Some(0.34));
}

#[test]
fn a_wishlist_key_nothing_answers_is_refused_by_name() {
    let conn = test_db();
    for key in [
        "wishlist:folder:nobody",
        "wishlist:deck:nobody",
        "wishlist:later:x",
    ] {
        let err = snapshot(
            &conn,
            "x",
            "Giradeli",
            Some(key),
            all(false),
            crate::sorting::Marketplace::Tcgplayer,
            0,
        )
        .unwrap_err();
        assert_eq!(err, WISHLIST_FOLDER_NOT_FOUND, "{key}");
    }
}

/// A wish's two free-text columns never reach the wire.
#[test]
fn no_private_wish_field_can_reach_the_wire() {
    let conn = test_db();
    card(&conn, "c1", "Fury Sliver");
    wish(&conn, Some("c1"), "o1", None, None);
    let json = serde_json::to_string(&snap(&conn, Some("wishlist:"))).unwrap();
    assert!(!json.contains("private-"), "{json}");
}

#[test]
fn a_whole_collection_share_carries_the_root_and_drops_locked_drawers() {
    let conn = test_db();
    let (open, _) = folder(&conn, None, "Binder", false);
    let (shut, _) = folder(&conn, None, "Display case", true);
    card(&conn, "c1", "Fury Sliver");
    card(&conn, "c2", "Tundra");
    card(&conn, "c3", "Black Lotus");
    entry(&conn, "c1", None, 1);
    entry(&conn, "c2", Some(open), 1);
    entry(&conn, "c3", Some(shut), 1);

    let s = snap(&conn, None);

    let mut names: Vec<&str> = s.cards.iter().map(|c| c.n.as_str()).collect();
    names.sort_unstable();
    assert_eq!(names, vec!["Fury Sliver", "Tundra"]);
    // Spec §3's title for this share, spelled here rather than read back from
    // `WHOLE_COLLECTION_TITLE` — an assertion that reads its own constant proves only that the
    // constant exists. The constant is checked against the same literal below.
    assert_eq!(s.title, "Collection");
    assert_eq!(WHOLE_COLLECTION_TITLE, "Collection");
}

/// **The negative half of the root arm, and the highest-consequence silent failure this module
/// has.** `read_cards` adds `e.folder_id IS NULL OR` only for a whole-collection share; without
/// that condition a share of one small binder carries every unfiled card the reader owns, with
/// no error and nothing on screen to show it. Every other fixture here either files at the root
/// *and* shares the whole collection, or shares a named folder and files nothing at the root —
/// so deleting the `if` leaves them all green. This one is the fence.
#[test]
fn a_named_folder_share_leaves_the_root_where_it_is() {
    let conn = test_db();
    let (binder, uid) = folder(&conn, None, "Binder", false);
    card(&conn, "c1", "Tundra");
    card(&conn, "c2", "Black Lotus");
    entry(&conn, "c1", Some(binder), 1);
    // Unfiled — the root of the collection, which this share does not include.
    entry(&conn, "c2", None, 1);

    let s = snap(&conn, Some(&uid));

    let names: Vec<&str> = s.cards.iter().map(|c| c.n.as_str()).collect();
    assert_eq!(
        names,
        vec!["Tundra"],
        "a named folder's share must not carry the reader's unfiled cards: {names:?}"
    );
}

/// The shared folder is the **root of its own tree**, whatever it is nested under at home.
/// Carrying its real `parent_id`'s uid would name a folder the snapshot does not contain —
/// a dangling edge for the viewer's tree walk, and the existence of a drawer nobody shared.
#[test]
fn the_shared_folder_is_the_root_of_the_tree_it_publishes() {
    let conn = test_db();
    let (outer, _) = folder(&conn, None, "Cabinet", false);
    let (inner, inner_uid) = folder(&conn, Some(outer), "Binder", false);
    let (leaf, leaf_uid) = folder(&conn, Some(inner), "Duals", false);
    card(&conn, "c1", "Tundra");
    entry(&conn, "c1", Some(leaf), 1);

    let s = snap(&conn, Some(&inner_uid));

    assert_eq!(s.title, "Binder", "the title is the shared folder's name");
    let shared = s.folders.iter().find(|f| f.uid == inner_uid).unwrap();
    assert_eq!(
        shared.parent, None,
        "the shared folder's own parent is not in the snapshot, so it is a root here"
    );
    let child = s.folders.iter().find(|f| f.uid == leaf_uid).unwrap();
    assert_eq!(
        child.parent.as_deref(),
        Some(inner_uid.as_str()),
        "an edge inside the snapshot survives"
    );
}

#[test]
fn fields_off_means_the_keys_are_absent_rather_than_null() {
    let conn = test_db();
    card(&conn, "c1", "Fury Sliver");
    entry(&conn, "c1", None, 1);
    let s = snapshot(
        &conn,
        "x",
        "Giradeli",
        None,
        all(false),
        crate::sorting::Marketplace::Tcgplayer,
        0,
    )
    .unwrap();
    let json = serde_json::to_string(&s).unwrap();
    assert!(!json.contains("\"c\":"), "condition must be absent: {json}");
    assert!(!json.contains("\"l\":"), "lang must be absent: {json}");
    assert!(!json.contains("\"p\":"), "price must be absent: {json}");
    assert!(json.contains("\"fields\":[]"));
}

/// `NONE` is schema v35's *not set*, an app sentinel and not a grade. A snapshot that carries
/// condition and a card that has none is an **absent** `c`, never the word.
#[test]
fn an_ungraded_copy_carries_no_condition_at_all() {
    let conn = test_db();
    card(&conn, "c1", "Fury Sliver");
    entry(&conn, "c1", None, 1);
    conn.execute("UPDATE collection_entries SET condition = 'NONE'", [])
        .unwrap();

    let s = snap(&conn, None);

    assert_eq!(s.cards[0].c, None);
    let json = serde_json::to_string(&s).unwrap();
    assert!(
        !json.contains("NONE"),
        "the sentinel must not reach the wire: {json}"
    );
    assert!(
        json.contains("\"condition\""),
        "the snapshot still says it answered the question: {json}"
    );
}

/// A marketplace that does not quote this printing's finish answers NULL, and NULL is an
/// **absent** `p` rather than a zero — the em dash every price surface in this app already
/// draws. Read flat it is `InvalidColumnType`, which fails the whole publish over one card:
/// the fixture is a foil copy of a printing listed only in `usd`, which is the ordinary case
/// and not an edge.
#[test]
fn an_unpriced_finish_carries_no_value_and_does_not_fail_the_publish() {
    let conn = test_db();
    card(&conn, "c1", "Fury Sliver");
    entry(&conn, "c1", None, 1);
    conn.execute("UPDATE collection_entries SET finish = 'foil'", [])
        .unwrap();

    let s = snap(&conn, None);

    assert_eq!(s.cards[0].p, None);
    assert!(
        s.fields.contains(&"value"),
        "the snapshot still says it answered the question"
    );
}

/// The image columns are read **positionally**, off the end of a select list this module builds
/// by hand — `snapshot.rs`'s `IMAGE_COL`. Nothing else in this file would notice an offset
/// that reads a folder uid as a URL, or reads nothing at all.
#[test]
fn the_front_face_picture_travels_with_the_card() {
    let conn = test_db();
    card(&conn, "c1", "Fury Sliver");
    entry(&conn, "c1", None, 1);

    let s = snap(&conn, None);

    assert_eq!(s.cards[0].img.as_deref(), Some(display_uri("c1").as_str()));
}

/// The `LEFT JOIN`'s whole reason: a printing that has left the corpus is still a card the
/// reader owns, so the row falls back to `e.card_id` rather than being dropped. Nothing else
/// here seeds an entry with no `cards` row, and an inner join would pass every other test in
/// this file while silently shortening a real reader's binder.
#[test]
fn a_copy_whose_printing_left_the_corpus_travels_under_its_id() {
    let conn = test_db();
    const GONE: &str = "0000579f-7b35-4ed3-b44c-db2a538066fe";
    // No `card()` call — `collection_entries.card_id` is a soft reference with no foreign key,
    // which is exactly what makes this state reachable in the field.
    entry(&conn, GONE, None, 2);

    let s = snap(&conn, None);

    assert_eq!(
        s.cards.len(),
        1,
        "an orphan is still a card the reader owns"
    );
    assert_eq!(s.cards[0].id, GONE);
    assert_eq!(s.cards[0].n, GONE, "the id stands in for the name");
    assert_eq!(s.cards[0].img, None, "and there is no picture to carry");
    assert_eq!(s.cards[0].q, 2);
}

/// Must hold for **every** input, which is why it sweeps the serialised text rather than the
/// struct: a field added to `ShareCard` in a year fails this without anyone remembering the rule.
///
/// **This is the fence the whole feature's privacy claim rests on, so it sweeps twice.** The
/// first list is spec §3's two lists of key names — the six columns that are *absent from the
/// format* and the eight that are absent because nothing draws them. The second is the
/// distinctive **values** [`entry`] writes into every one of those columns that can hold a
/// string: a key-name sweep alone passes over a field renamed on the way out, and over a short
/// key like `p` that carries a private number under a public name.
///
/// ⚠️ **A column the fixture never sets is fenced by its key name alone, whatever this list
/// says** — see [`entry`]. `needs_review` sat on both halves of the list and was NULL on every
/// row until 2026-09-08, so the value half of it proved nothing; `condition_original` was on
/// neither half nor in spec §3.
#[test]
fn no_private_field_can_reach_the_wire() {
    let conn = test_db();
    let (binder, _) = folder(&conn, None, "Binder", false);
    card(&conn, "c1", "Fury Sliver");
    card(&conn, "c2", "Tundra");
    entry(&conn, "c1", None, 3);
    entry(&conn, "c2", Some(binder), 1);
    let json = serde_json::to_string(&snap(&conn, None)).unwrap();
    for forbidden in [
        // Spec §3's first list — absent from the format, never switched off in it.
        "purchase",
        "acquired",
        "acquisition",
        "notes",
        "tags",
        // Spec §3's second list — absent because nothing in the viewer draws them.
        "needsReview",
        "needs_review",
        "tradelist",
        "grading",
        "serial",
        "altered",
        "signed",
        "proxy",
        "misprint",
        // Arbitrary text out of the reader's own import file — what their spreadsheet said
        // before the grade was normalised. On neither list until 2026-09-08.
        "conditionOriginal",
        "condition_original",
        // The values themselves, one per column `entry` can write a string into.
        "private-currency-DKK",
        "private-acquired-2019-08-02",
        "private-source GP Copenhagen",
        "private-notes bought at a GP",
        "private-tag",
        "private-serial-042/500",
        "private-grader",
        "private-graded-GD",
        "private-review this printing left Scryfall",
        "bought at a GP",
        "9.99",
    ] {
        assert!(
            !json.contains(forbidden),
            "`{forbidden}` reached a share snapshot, which spec section 3 forbids: {json}"
        );
    }
}

/// Spec section 3.1 has no measured figure and says so. This is the measurement. It **prints**
/// rather than asserting a byte count, so it reports rather than rots.
///
/// **The fixture is deliberately not `card()`/`entry()`'s.** Those two hold every printing at
/// `tsp 157` with a two-byte id, and DEFLATE erases a thousand identical set codes to nothing —
/// a figure taken over them would understate a real binder by more than the caps it is setting.
/// So: uuid-shaped ids, distinct names, collector numbers that climb, and a rotation through
/// four sets, three finishes and the five grades.
#[test]
fn a_thousand_card_snapshot_is_measured() {
    const N: usize = 1000;
    const SETS: [&str; 4] = ["tsp", "mh3", "otj", "lci"];
    const FINISHES: [&str; 3] = ["nonfoil", "foil", "etched"];
    const GRADES: [&str; 5] = ["NM", "LP", "MP", "HP", "DMG"];

    let conn = test_db();
    let (f, uid) = folder(&conn, None, "Binder", false);
    for i in 0..N {
        // Scryfall's own shape — 32 hex digits and four hyphens — because the id appears twice
        // in every card (once as `id`, once inside `img`) and a `c17` would make the per-card
        // figure meaningless. Four odd multipliers, so the digits are spread rather than
        // counting up: multiplication by an odd word mod 2^32 is a bijection, so every id is
        // distinct and none of them is a prefix of the next.
        let n = i as u32 + 1;
        let (a, b, c, d) = (
            0x9e37_79b9u32.wrapping_mul(n),
            0x85eb_ca6bu32.wrapping_mul(n),
            0xc2b2_ae35u32.wrapping_mul(n),
            0x27d4_eb2fu32.wrapping_mul(n),
        );
        let id = format!(
            "{a:08x}-{:04x}-{:04x}-{:04x}-{:04x}{d:08x}",
            b >> 16,
            b & 0xffff,
            c >> 16,
            c & 0xffff
        );
        let set = SETS[i % SETS.len()];
        conn.execute(
            "INSERT INTO cards (id, name, set_code, collector_number, lang, layout, raw,
                                image_uris, prices)
             VALUES (?1, ?2, ?3, ?4, 'en', 'normal', '{}',
                     json_object('display', ?5), json_object('usd', ?6))",
            params![
                id,
                format!("Test Card {i} of the Measured Binder"),
                set,
                (i + 1).to_string(),
                display_uri(&id),
                format!("{}.{:02}", i % 40, i % 100),
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO collection_entries
               (card_id, set_code, collector_number, lang, finish, condition, quantity,
                tradelist_quantity, folder_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'en', ?4, ?5, ?6, 0, ?7, 0, 0)",
            params![
                id,
                set,
                (i + 1).to_string(),
                FINISHES[i % FINISHES.len()],
                GRADES[i % GRADES.len()],
                (i % 4 + 1) as i64,
                f
            ],
        )
        .unwrap();
    }

    let s = snap(&conn, Some(&uid));
    assert_eq!(s.cards.len(), N, "every seeded copy is in the snapshot");
    let json = serde_json::to_vec(&s).unwrap();
    let gz = gzip(&json).unwrap();
    println!(
        "1000 cards: {} B raw, {} B gzipped, {:.1} B/card gzipped",
        json.len(),
        gz.len(),
        gz.len() as f64 / 1000.0
    );
    assert!(
        gz.len() < json.len(),
        "gzip must actually compress a snapshot"
    );
}

/// The fence. `packages/ui/features/transfer/__golden__/` is the precedent and the reason is the same,
/// one degree harder: this format has **three** implementations, not two — one Rust writer here
/// and two TypeScript readers over `packages/ui/lib/shareSnapshot.ts`, which parses this very file in
/// its own suite.
///
/// **What it pins is a wire document, not a struct**, which is why the assertion is byte
/// equality against a committed file rather than a walk over fields: a `#[serde(rename)]`, a
/// reordered declaration and a key that silently stopped being emitted are all invisible to a
/// field-by-field check and all break a viewer.
///
/// The fixture is deliberately a **full** snapshot — every card graded, priced and in the
/// corpus — so the golden shows what every key looks like when it is there. The format's three
/// absences (`c` on an ungraded copy, `p` on a finish the marketplace does not quote, and
/// `parent: null` on a folder whose real parent is outside the share) each have a test of their
/// own above, and are called out in the TypeScript mirror's doc comment because a viewer that
/// reads `fields` as a promise about every card is the failure they add up to.
#[test]
fn the_golden_snapshot_is_what_the_writer_produces() {
    let conn = test_db();
    let (f, uid) = folder(&conn, None, "Trade binder", false);
    let (child, _) = folder(&conn, Some(f), "Duals", false);
    card(&conn, "0000579f-7b35-4ed3-b44c-db2a538066fe", "Fury Sliver");
    card(&conn, "56ebc372-aabd-4174-a943-c7bf59e5028d", "Tundra");
    entry(&conn, "0000579f-7b35-4ed3-b44c-db2a538066fe", Some(f), 2);
    entry(
        &conn,
        "56ebc372-aabd-4174-a943-c7bf59e5028d",
        Some(child),
        1,
    );

    let got = serde_json::to_string_pretty(&snap(&conn, Some(&uid))).unwrap();
    let want = include_str!("__golden__/snapshot.json");

    // `\r\n` is what a Windows checkout can hand back — a subagent write has flipped a file to
    // CRLF in this repo before, and the resulting diff is invisible in a terminal. The
    // committed file is LF; this only stops a checkout setting from failing the build.
    assert_eq!(got.trim_end(), want.replace("\r\n", "\n").trim_end());
}

/* ------------------------------------------------------------------ decks, issue #1032 --- */

/// A Commander deck with a uid, its predefined piles seeded by `create_deck` itself — so the
/// piles a share reads are the ones the app really makes, not a hand-written agreement about them.
fn shared_deck(conn: &Connection, name: &str, uid: &str) -> i64 {
    let deck = crate::deck::create_deck(
        conn,
        &crate::deck::DeckInput {
            name: name.to_owned(),
            format_key: "commander".to_owned(),
            ..Default::default()
        },
    )
    .unwrap();
    conn.execute(
        "UPDATE decks SET sync_uid = ?2 WHERE id = ?1",
        params![deck.id, uid],
    )
    .unwrap();
    deck.id
}

/// The live list's predefined pile of `kind`.
fn zone(conn: &Connection, deck: i64, kind: &str) -> i64 {
    conn.query_row(
        "SELECT id FROM deck_categories WHERE deck_id = ?1 AND kind = ?2 AND variant = 'live'",
        params![deck, kind],
        |r| r.get(0),
    )
    .unwrap()
}

/// A printing a deck can be built from: a type line, a cost and a value on top of [`card`].
fn spell(conn: &Connection, id: &str, name: &str, type_line: &str, cost: &str, mv: f64) {
    card(conn, id, name);
    conn.execute(
        "UPDATE cards SET type_line = ?2, mana_cost = ?3, cmc = ?4 WHERE id = ?1",
        params![id, type_line, cost, mv],
    )
    .unwrap();
}

fn put(conn: &Connection, deck: i64, card: &str, pile: i64, qty: i64) {
    crate::deck::add_card(conn, deck, card, Some(pile), None, "live", None, qty).unwrap();
}

#[test]
fn deck_keys_parse_and_are_told_from_folders_and_wishlists() {
    assert_eq!(super::deck::parse("deck:abc"), Some("abc"));
    assert_eq!(super::deck::parse("deck:"), Some(""));
    assert_eq!(super::deck::parse("wishlist:deck:abc"), None);
    assert_eq!(super::deck::parse("0123456789abcdef0123456789abcdef"), None);
}

/// The live list, pile by pile in the reader's order: a pile is a folder, its role rides in
/// `deck`, every card carries the three facts a deck is read by, and the plan stays home.
#[test]
fn a_deck_share_carries_its_live_list_as_piles() {
    let conn = test_db();
    spell(
        &conn,
        "k1",
        "Krenko, Mob Boss",
        "Legendary Creature — Goblin Warrior",
        "{2}{R}{R}",
        4.0,
    );
    spell(&conn, "b1", "Lightning Bolt", "Instant", "{R}", 1.0);
    spell(&conn, "m1", "Mountain", "Basic Land — Mountain", "", 0.0);
    spell(&conn, "s1", "Shock", "Instant", "{R}", 1.0);
    let deck = shared_deck(&conn, "Krenko", "deckuid-krenko");
    put(&conn, deck, "k1", zone(&conn, deck, "commander"), 1);
    let burn = crate::deck_meta::create_category(&conn, deck, "live", "Burn").unwrap();
    put(&conn, deck, "b1", burn.id, 1);
    let lands = crate::deck_meta::create_category(&conn, deck, "live", "Lands").unwrap();
    put(&conn, deck, "m1", lands.id, 30);
    put(&conn, deck, "s1", zone(&conn, deck, "maybe"), 1);
    // A pile whose only row is the plan's: it holds nothing of the live list, so it does not travel.
    let plan = crate::deck_meta::create_category(&conn, deck, "live", "Plan").unwrap();
    put(&conn, deck, "s1", plan.id, 2);
    conn.execute(
        "UPDATE deck_cards SET variant = 'theory' WHERE category_id = ?1",
        params![plan.id],
    )
    .unwrap();

    let s = snap(&conn, Some("deck:deckuid-krenko"));
    assert_eq!(s.title, "Krenko");
    // A deck row has no condition, so the question is not claimed.
    assert_eq!(s.fields, vec!["lang", "value"]);

    let deck = s.deck.as_ref().expect("a deck share carries its deck half");
    assert_eq!(deck.format, "Commander");
    let piles: Vec<(&str, &str, bool)> = deck
        .piles
        .iter()
        .map(|p| {
            let name = s.folders.iter().find(|f| f.uid == p.uid).unwrap();
            (name.name.as_str(), p.kind.as_str(), p.active)
        })
        .collect();
    // The seeded zones first in their seeded order, then the reader's — the Categories view.
    assert_eq!(
        piles,
        vec![
            ("Commander", "commander", true),
            ("Maybeboard", "maybe", false),
            ("Burn", "main", true),
            ("Lands", "main", true),
        ]
    );
    assert!(s.folders.iter().all(|f| f.parent.is_none()));
    assert!(
        s.folders.iter().all(|f| f.uid.starts_with("pile-")),
        "a pile's position, never its row id"
    );

    let bolt = s.cards.iter().find(|c| c.n == "Lightning Bolt").unwrap();
    assert_eq!(bolt.t.as_deref(), Some("Instant"));
    assert_eq!(bolt.mc.as_deref(), Some("{R}"));
    assert_eq!(bolt.mv, Some(1.0));
    assert_eq!(bolt.f, "nonfoil");
    assert_eq!(bolt.p, Some(0.34));
    assert!(bolt.c.is_none());
    let burn_uid = &s.folders.iter().find(|f| f.name == "Burn").unwrap().uid;
    assert_eq!(bolt.fo.as_ref(), Some(burn_uid));

    // A land's empty cost is an absent `mc`, never `""`.
    let mountain = s.cards.iter().find(|c| c.n == "Mountain").unwrap();
    assert_eq!(mountain.q, 30);
    assert!(mountain.mc.is_none());

    // The plan's two Shocks did not travel; the Maybeboard's one did.
    let shocks: i64 = s.cards.iter().filter(|c| c.n == "Shock").map(|c| c.q).sum();
    assert_eq!(shocks, 1);
}

#[test]
fn a_deck_key_nothing_answers_is_refused_by_name() {
    let conn = test_db();
    shared_deck(&conn, "Krenko", "deckuid-krenko");
    for key in ["deck:nobody", "deck:"] {
        let err = snapshot(
            &conn,
            "x",
            "Giradeli",
            Some(key),
            all(false),
            crate::sorting::Marketplace::Tcgplayer,
            0,
        )
        .unwrap_err();
        assert_eq!(err, DECK_NOT_FOUND, "{key}");
    }
}

/// A binder's snapshot carries none of the deck's keys, so it is the document it always was.
#[test]
fn a_binder_carries_no_deck_half_and_no_deck_facts() {
    let conn = test_db();
    let (f, uid) = folder(&conn, None, "Binder", false);
    spell(&conn, "b1", "Lightning Bolt", "Instant", "{R}", 1.0);
    entry(&conn, "b1", Some(f), 1);
    let json = serde_json::to_value(snap(&conn, Some(&uid))).unwrap();
    assert!(json.get("deck").is_none(), "{json}");
    let card = &json["cards"][0];
    for key in ["t", "mc", "mv"] {
        assert!(card.get(key).is_none(), "{key} on a binder's card: {card}");
    }
}

/// The reader's own words about their deck never reach the wire — the description, the tags and
/// a row's review sentence, each carrying a marker the sweep looks for.
#[test]
fn no_private_deck_field_can_reach_the_wire() {
    let conn = test_db();
    spell(&conn, "b1", "Lightning Bolt", "Instant", "{R}", 1.0);
    let deck = shared_deck(&conn, "Burn", "deckuid-burn");
    let pile = crate::deck_meta::create_category(&conn, deck, "live", "Burn").unwrap();
    put(&conn, deck, "b1", pile.id, 4);
    conn.execute(
        "UPDATE decks SET description = 'private-description', tags = '[\"private-tag\"]'
          WHERE id = ?1",
        params![deck],
    )
    .unwrap();
    conn.execute(
        "UPDATE deck_cards SET needs_review = 'private-review' WHERE deck_id = ?1",
        params![deck],
    )
    .unwrap();
    let json = serde_json::to_string(&snap(&conn, Some("deck:deckuid-burn"))).unwrap();
    assert!(!json.contains("private-"), "{json}");
}

/// The deck format's fence, `the_golden_snapshot_is_what_the_writer_produces`' twin: the two
/// TypeScript viewers parse this very file, so the three implementations agree on a deck too.
#[test]
fn the_golden_deck_snapshot_is_what_the_writer_produces() {
    let conn = test_db();
    spell(
        &conn,
        "5d8a1ab2-4c53-4b2b-a9e4-1e3c0e7d2f01",
        "Krenko, Mob Boss",
        "Legendary Creature — Goblin Warrior",
        "{2}{R}{R}",
        4.0,
    );
    spell(
        &conn,
        "e3285e6b-3e79-4d7c-bf96-d920f973b80d",
        "Lightning Bolt",
        "Instant",
        "{R}",
        1.0,
    );
    let deck = shared_deck(&conn, "Krenko's Goblins", "deckuid-krenko");
    put(
        &conn,
        deck,
        "5d8a1ab2-4c53-4b2b-a9e4-1e3c0e7d2f01",
        zone(&conn, deck, "commander"),
        1,
    );
    let burn = crate::deck_meta::create_category(&conn, deck, "live", "Burn").unwrap();
    put(
        &conn,
        deck,
        "e3285e6b-3e79-4d7c-bf96-d920f973b80d",
        burn.id,
        1,
    );

    let got = serde_json::to_string_pretty(&snap(&conn, Some("deck:deckuid-krenko"))).unwrap();
    let want = include_str!("__golden__/deck.json");
    assert_eq!(got.trim_end(), want.replace("\r\n", "\n").trim_end());
}

/// A deck share's link preview shows its commander (issue #1032) — read off the very document
/// being uploaded — and the first card in the deck when there is no commander.
#[test]
fn a_deck_previews_as_its_commander_and_a_binder_as_nothing() {
    let conn = test_db();
    spell(
        &conn,
        "k1",
        "Krenko, Mob Boss",
        "Legendary Creature — Goblin",
        "{2}{R}{R}",
        4.0,
    );
    spell(&conn, "b1", "Lightning Bolt", "Instant", "{R}", 1.0);
    let deck = shared_deck(&conn, "Krenko", "deckuid-krenko");
    let burn = crate::deck_meta::create_category(&conn, deck, "live", "Burn").unwrap();
    put(&conn, deck, "b1", burn.id, 1);

    // No commander yet: the first card played in the deck.
    let s = snap(&conn, Some("deck:deckuid-krenko"));
    assert_eq!(
        super::deck::preview_image(&s),
        Some(display_uri("b1").as_str())
    );

    put(&conn, deck, "k1", zone(&conn, deck, "commander"), 1);
    let s = snap(&conn, Some("deck:deckuid-krenko"));
    assert_eq!(
        super::deck::preview_image(&s),
        Some(display_uri("k1").as_str())
    );

    let (f, uid) = folder(&conn, None, "Binder", false);
    entry(&conn, "b1", Some(f), 1);
    assert_eq!(super::deck::preview_image(&snap(&conn, Some(&uid))), None);
}
