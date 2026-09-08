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
/// **`display` and not `normal`**: [`crate::image_uri::LIST_VARIANT`] is the key
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
fn entry(conn: &rusqlite::Connection, card_id: &str, folder: Option<i64>, qty: i64) {
    conn.execute(
        "INSERT INTO collection_entries
           (card_id, set_code, collector_number, lang, finish, condition, quantity,
            tradelist_quantity, purchase_price, purchase_currency, acquired_at,
            acquisition_source, notes, tags, serial_number, grading,
            altered, signed, proxy, misprint, folder_id, created_at, updated_at)
         VALUES (?1, 'tsp', '157', 'en', 'nonfoil', 'NM', ?2, 7, 9.99,
                 'private-currency-DKK', 'private-acquired-2019-08-02',
                 'private-source GP Copenhagen', 'private-notes bought at a GP',
                 '[\"private-tag\"]', 'private-serial-042/500',
                 '{\"company\":\"private-grader\",\"grade\":10}',
                 1, 1, 1, 1, ?3, 0, 0)",
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

/// The two refusals beside [`FOLDER_IS_LOCKED`], and the **order** between them: a folder that
/// is not there may never report as locked, because "unlock it" is advice a reader cannot act
/// on for a drawer that does not exist.
#[test]
fn a_missing_folder_and_an_app_owned_one_are_each_refused_by_name() {
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

    let group = deck_group(&conn, "Krenko");
    let uid: String = conn
        .query_row(
            "SELECT sync_uid FROM collection_folders WHERE id = ?1",
            params![group],
            |r| r.get(0),
        )
        .unwrap();
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
    assert_eq!(err, FOLDER_NOT_SHAREABLE);
}

#[test]
fn a_deck_group_and_recently_removed_never_travel() {
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

    assert!(s.cards.is_empty(), "an app-owned folder is not a binder");
    assert!(s.folders.is_empty());
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
/// by hand — `deck.rs`'s `IMAGE_COL` trap. Nothing else in this file would notice an offset
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
        // The values themselves, one per column `entry` can write a string into.
        "private-currency-DKK",
        "private-acquired-2019-08-02",
        "private-source GP Copenhagen",
        "private-notes bought at a GP",
        "private-tag",
        "private-serial-042/500",
        "private-grader",
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

/// The fence. `src/features/transfer/__golden__/` is the precedent and the reason is the same,
/// one degree harder: this format has **three** implementations, not two — one Rust writer here
/// and two TypeScript readers over `src/lib/shareSnapshot.ts`, which parses this very file in
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
