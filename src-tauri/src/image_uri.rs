//! Where a printing's picture is, and whether what is there is a picture at all.
//!
//! `images` is the permanent byte cache, the placeholders and the `mtgimg://` protocol
//! handler. The *resolution rule* underneath it is none of those: it is two columns of `cards`,
//! a precedence between them, and a predicate over a string. The share snapshot needs exactly
//! that much to put a URL on a published card, so the rule lives in a module of its own.
//!
//! Three things live here and nothing else does:
//!
//! * **Which two columns a picture can be in** — [`TOP_LEVEL_COLUMN`] and [`FACE_COLUMN`],
//!   read by [`row`] for one variant and one face, and by [`front_face_selects`] for
//!   [`FRONT_FACE_VARIANT`] on the front face.
//! * **The precedence between them** — [`for_face`], face first and top-level as the
//!   fallback, and only for face 0.
//! * **Whether the URI is one this app will use at all** — [`is_fetchable`].

use rusqlite::{params, Connection, OptionalExtension};

/// The only host this app will fetch a card image from.
///
/// The trailing slash is the entire check. `https://cards.scryfall.io.evil.test/…` and
/// `https://cards.scryfall.io@evil.test/…` both fail it, because the byte after the host
/// has to be the path separator — which is what makes a `starts_with` a host comparison
/// rather than a substring search.
pub const IMAGE_HOST: &str = "https://cards.scryfall.io/";

/// The two columns a printing's picture can be in, named once.
///
/// `image_uris` is the whole card's blob and `face_image_uris` is a JSON **array**, one
/// entry per `card_faces` entry in that order, with a `null` in place for a face the source
/// gave no images for (`card_row::webp_uris`). 3.7% of printings carry no top-level blob at
/// all — `transform`, `modal_dfc`, `double_faced_token`, `art_series` and `reversible_card`
/// put them on the faces instead — which is why a reader of one column is a reader of a
/// picture that is not there.
pub const TOP_LEVEL_COLUMN: &str = "image_uris";
/// The per-face blob. See [`TOP_LEVEL_COLUMN`].
pub const FACE_COLUMN: &str = "face_image_uris";

/// Does `uri` carry the `?<epoch>` cache-buster the whole invalidation rule stands on?
///
/// Digits, not merely a query string: `?<epoch>` is `image_updated_at`, and the point is
/// that it *moves* when Scryfall re-scans the card. A `?` followed by anything else is not
/// a version, it is punctuation.
pub fn has_cache_buster(uri: &str) -> bool {
    uri.split_once('?')
        .is_some_and(|(_, v)| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()))
}

/// Is this a URI worth fetching — and, more to the point, worth *keeping*?
///
/// Both halves answer a live defect rather than a hypothesis. Eight printings in the
/// current bulk data (`plst UMA-149`, `mic 55`–`58`, three more) publish
/// `https://errors.scryfall.com/soon.jpg` in all four `image_uris` slots: Scryfall's own
/// error page, as a JPEG, on a host that is not the image CDN, with nothing after it.
/// Fetched, those bytes would be written as `<id>-0.webp` and — because
/// `images::is_current` compares URIs and this URI can never change — served as
/// that card's artwork forever. No re-sync would clear it and no re-scan could, because
/// there is nothing there to re-scan. Deleting `data/images` would not even help: the next
/// request would fetch the same error page again.
///
/// So the version rule is the one that catches today's eight, and the host allowlist is
/// the belt for whatever the next placeholder host turns out to be.
///
/// **It is part of the rule and not a detail of the cache.** A share snapshot that skipped it
/// would hand a viewer's browser a URL that answers `200` with something that is not the card,
/// which is the same failure one layer further out.
///
/// Scryfall says the same thing in a second place — all eight carry `image_status`
/// `'missing'`, and the column is already on `cards` — but that is a *label* on the data
/// and this is a property of the URI itself: a versionless URI is uncacheable whatever any
/// status field claims, and it is the one of the two that cannot be wrong. `image_status`
/// is the right signal for the other half of spec §5, re-fetching when a picture improves
/// from `lowres`/`placeholder`, which is Plan-3 work.
pub fn is_fetchable(uri: &str) -> bool {
    has_cache_buster(uri) && is_allowed_host(uri)
}

/// The host half of [`is_fetchable`], named because `images::resolve` asks it a
/// second time to decide whether a refusal is worth a line on stderr.
///
/// `cfg!` the macro, not the attribute: [`is_image_host`] stays compiled and directly
/// tested in both configurations rather than being swapped for something weaker. The
/// widening exists because `images`' fetch tests run against an `httpmock` server on
/// loopback, and it is the only seam in this predicate.
pub fn is_allowed_host(uri: &str) -> bool {
    is_image_host(uri) || (cfg!(test) && is_loopback(uri))
}

pub fn is_image_host(uri: &str) -> bool {
    uri.starts_with(IMAGE_HOST)
}

pub fn is_loopback(uri: &str) -> bool {
    uri.starts_with("http://127.0.0.1:") || uri.starts_with("http://localhost:")
}

/// The two columns a printing's picture can be in, for one variant and one face.
///
/// `(top_level, face)` — `image_uris` and `card_faces[face].image_uris`, spec §5's pair.
/// `None` for a card that is not in the corpus.
///
/// One function because two readers want the same row and apply **different policies** to it:
/// `images::resolve` falls back from face to top-level only for face 0 and then puts
/// the answer through [`is_fetchable`], while `card::card_image_uri_inner` pins the face to 0
/// and deliberately skips that fence. That difference is real and stays; what may not differ
/// is which two columns the picture lives in, and this module is the one place that says so —
/// [`front_face_selects`] builds the share snapshot's copy of the same pair from the same two
/// constants.
///
/// **Read-only by contract**, like `images::resolve`: every caller passes `db_read`.
#[allow(clippy::type_complexity)]
pub fn row(
    conn: &Connection,
    card_id: &str,
    variant: &str,
    face: i64,
) -> Result<Option<(Option<String>, Option<String>)>, String> {
    conn.query_row(
        &format!(
            "SELECT json_extract({TOP_LEVEL_COLUMN}, '$.' || ?2),
                    json_extract({FACE_COLUMN}, '$[' || ?3 || '].' || ?2)
             FROM cards WHERE id = ?1"
        ),
        params![card_id, variant, face],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Spec §5's precedence over the pair [`row`] answers: **the face wins, the top-level blob
/// is the fallback, and only face 0 has one.**
///
/// The order is the whole of it and reversing it ships a *wrong* picture rather than a
/// missing one. A transform's back exists only on the face, so falling back to the
/// top-level image for face 1 would show the front of the card on its own back; and a
/// `meld` printing carries both columns, where the top-level image is its front and nothing
/// else — so a top-level-first reading of face 0 is right for a `meld` card by accident and
/// wrong for every card whose faces carry a better picture.
pub fn for_face(top: Option<String>, face: Option<String>, face_index: u8) -> Option<String> {
    face.or_else(|| (face_index == 0).then_some(top).flatten())
}

/// The one variant a caller reads through [`front_face_selects`]: Scryfall's `display`, the
/// card-shaped picture.
///
/// **The share snapshot is its one reader.** A published card carries a whole Scryfall URL
/// because the public share viewer is a web page on somebody else's machine, with no Tauri
/// behind it to answer `mtgimg://`. **List DTOs stopped carrying URLs on 2026-09-27**, when the
/// browser build went: the desktop draws every picture through `mtgimg://`, so the `imageUris`
/// map on search, collection, wishlist and deck rows had no reader left. It cost 224 B a row —
/// a 50-row search page was 34 396 B with it and 23 196 B without.
///
/// **Not [`crate::schema::IMAGE_VARIANTS`]**, which is the wider list of what the ingest
/// *stores*; what is fenced here is only that the name is one of them
/// ([`tests::the_front_face_variant_is_one_the_schema_stores`]).
pub const FRONT_FACE_VARIANT: &str = "display";

/// How many columns [`front_face_selects`] adds to a `SELECT` — the (top-level, face) pair.
pub const FRONT_FACE_COLUMNS: usize = 2;

/// The front face's `(top_level, face)` pair for [`FRONT_FACE_VARIANT`] —
/// [`FRONT_FACE_COLUMNS`] `json_extract`s, top-level first, for a caller that already has the
/// `cards` row in its `FROM` and reads them off the row it is holding rather than joining or
/// querying again.
///
/// The precedence is deliberately **not** spelled here as a `COALESCE` — [`for_face`] is the
/// one implementation of it, and this hands both halves back for [`front_face_uri`] to decide
/// between. The variant reaches SQL as a `json_extract` path and is **never** a caller's
/// string: it is a literal constant. `alias` is a table alias the caller wrote into its own
/// `FROM` in the same breath.
///
/// # Why a whole URL travels, when ten bytes of it would do
///
/// **Every stored URL is derivable from the row's own id.** Measured 2026-08-29 against the
/// 117 606-row dev corpus: all 117 444 rows carrying a front-face `display` URL match
/// `https://cards.scryfall.io/<variant>/front/<id[0]>/<id[1]>/<id>.webp?<epoch>` exactly, so a
/// card could carry its ten-digit epoch alone. It was set aside for two reasons, neither of
/// them the bytes: the template would be a second implementation of *Scryfall's* URL scheme,
/// in the viewer, where the stored URI is simply authoritative — the day the two part company
/// the symptom is a wall of broken images with nothing in the data to blame; and it would
/// degrade [`is_fetchable`] to *"does an epoch exist"*, because the host allowlist has nothing
/// left to check once the host is a literal we wrote ourselves, and that predicate is the whole
/// fence against `soon.jpg`.
pub fn front_face_selects(alias: &str) -> [String; FRONT_FACE_COLUMNS] {
    [
        format!("json_extract({alias}.{TOP_LEVEL_COLUMN}, '$.{FRONT_FACE_VARIANT}')"),
        format!("json_extract({alias}.{FACE_COLUMN}, '$[0].{FRONT_FACE_VARIANT}')"),
    ]
}

/// Fold the pair [`front_face_selects`] added back into the front face's one URL, applying
/// [`for_face`] and then [`is_fetchable`].
///
/// `read` is handed an index into that pair, `0..FRONT_FACE_COLUMNS`, so the pairing arithmetic
/// stays next to the SQL that produced it rather than being spelled a second time at the call
/// site. `None` when the printing has no fetchable picture in either column — what every other
/// "no picture" answer in this crate looks like.
pub fn front_face_uri<E>(
    mut read: impl FnMut(usize) -> Result<Option<String>, E>,
) -> Result<Option<String>, E> {
    let top = read(0)?;
    let face = read(1)?;
    Ok(for_face(top, face, 0).filter(|u| is_fetchable(u)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A normal card (top-level images), a transform (per-face), and a `meld`-shaped row
    /// that carries **both** — which is the only shape the precedence can be measured on.
    ///
    /// **Every row carries a *different* picture in every slot it has**, and that is what makes
    /// a mistake in [`front_face_selects`]/[`front_face_uri`] visible. A path naming the wrong
    /// variant still reads a real URL off `bolt`, which carries all four, and a pair read in the
    /// wrong order still reads a real URL off `meld`, whose top-level and face 0 disagree — so
    /// each mistake changes an assertion below, where on a fixture carrying one column, or the
    /// same URL in both, neither would.
    fn seeded() -> Connection {
        let conn = crate::schema::memory_pair();
        conn.execute(
            "INSERT INTO cards (id, name, set_code, collector_number, lang, layout, image_uris, raw)
             VALUES ('bolt','Bolt','lea','161','en','normal',
                     json_object(
                       'thumb','https://cards.scryfall.io/thumb/front/0/0/x.webp?17',
                       'grid','https://cards.scryfall.io/grid/front/0/0/x.webp?17',
                       'display','https://cards.scryfall.io/display/front/0/0/x.webp?17',
                       'art','https://cards.scryfall.io/art/front/0/0/x.webp?17'), '{}')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cards (id, name, set_code, collector_number, lang, layout, face_image_uris, raw)
             VALUES ('delver','Delver','isd','51','en','transform',
                     json_array(
                       json_object('grid','https://cards.scryfall.io/grid/front/a/b/y.webp?9',
                                   'display','https://cards.scryfall.io/display/front/a/b/y.webp?9',
                                   'art','https://cards.scryfall.io/art/front/a/b/y.webp?9'),
                       json_object('grid','https://cards.scryfall.io/grid/back/a/b/y.webp?9',
                                   'display','https://cards.scryfall.io/display/back/a/b/y.webp?9',
                                   'art','https://cards.scryfall.io/art/back/a/b/y.webp?9')), '{}')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cards (id, name, set_code, collector_number, lang, layout, image_uris, face_image_uris, raw)
             VALUES ('meld','Bruna','emn','15','en','meld',
                     json_object('display','https://cards.scryfall.io/display/top.webp?1',
                                 'art','https://cards.scryfall.io/art/top.webp?1'),
                     json_array(json_object(
                                 'display','https://cards.scryfall.io/display/face0.webp?1',
                                 'art','https://cards.scryfall.io/art/face0.webp?1')), '{}')",
            [],
        )
        .unwrap();
        conn
    }

    /// The one row both readers take. `card::card_image_uri_inner` and
    /// `images::resolve` each apply their own policy to it — the card pane
    /// deliberately skips the host fence — but they must never disagree about *which two
    /// columns* a printing's picture is in.
    #[test]
    fn the_row_answers_both_columns_and_none_for_an_unknown_card() {
        let conn = seeded();

        // The plain printing: a top-level image for every variant, no per-face ones.
        let (top, face) = row(&conn, "bolt", "grid", 0)
            .unwrap()
            .expect("a card that is in the corpus answers a row");
        assert_eq!(
            top.as_deref(),
            Some("https://cards.scryfall.io/grid/front/0/0/x.webp?17")
        );
        assert_eq!(face, None, "a normal printing carries no per-face images");

        // The transform: per-face images and no top-level one, and face 1 is its own picture.
        // Which of the two a caller then *uses* is the caller's policy, not this function's.
        let (top, face) = row(&conn, "delver", "grid", 1).unwrap().unwrap();
        assert_eq!(top, None, "a transform carries no top-level image");
        assert_eq!(
            face.as_deref(),
            Some("https://cards.scryfall.io/grid/back/a/b/y.webp?9")
        );

        assert!(
            row(&conn, "not-a-card", "grid", 0).unwrap().is_none(),
            "an unknown card is None, not an error"
        );
    }

    /// The precedence, on the shape that can tell the two orders apart: a `meld` printing
    /// carrying a top-level blob **and** a face 0 blob for the same variant.
    ///
    /// A `COALESCE(top, face)` passes every other test in this file — a transform has no
    /// top-level image and a normal card has no faces — and draws Bruna's melded picture
    /// where her front belongs, silently.
    #[test]
    fn the_front_face_wins_over_the_top_level_image() {
        assert_eq!(
            for_face(Some("top".into()), Some("face".into()), 0).as_deref(),
            Some("face"),
            "face first: a meld card's top-level image is its front and nothing else"
        );
        assert_eq!(
            for_face(Some("top".into()), None, 0).as_deref(),
            Some("top"),
            "the top-level blob is the fallback, not the first answer"
        );
        assert_eq!(
            for_face(Some("top".into()), Some("back".into()), 1).as_deref(),
            Some("back")
        );
        assert_eq!(
            for_face(Some("top".into()), None, 1),
            None,
            "no top-level fallback past the front: that would draw the front on the back"
        );
        assert_eq!(for_face(None, None, 0), None);
    }

    /// The two halves of [`is_fetchable`], separately, because they fail for different
    /// reasons and only one of them is a security boundary.
    ///
    /// The host check is a `starts_with` and that is only a host comparison because of the
    /// trailing slash — the near-misses below are the ones that would make it a substring
    /// search instead, and they are exactly the shapes an attacker-supplied `image_uris`
    /// would take if the bulk file were ever tampered with in transit.
    #[test]
    fn only_a_versioned_uri_on_the_image_host_is_worth_fetching() {
        for good in [
            "https://cards.scryfall.io/grid/front/0/0/x.webp?1699999999",
            "https://cards.scryfall.io/art/back/a/b/y.webp?0",
        ] {
            assert!(has_cache_buster(good), "{good}");
            assert!(is_image_host(good), "{good}");
            assert!(is_fetchable(good), "{good}");
        }

        // No version: nothing here can ever be invalidated, whoever serves it.
        for versionless in [
            "https://errors.scryfall.com/soon.jpg",
            "https://cards.scryfall.io/grid/front/0/0/x.webp",
            "https://cards.scryfall.io/grid/front/0/0/x.webp?",
            "https://cards.scryfall.io/grid/front/0/0/x.webp?v=17",
            "https://cards.scryfall.io/grid/front/0/0/x.webp?latest",
            "",
        ] {
            assert!(!has_cache_buster(versionless), "{versionless}");
            assert!(!is_fetchable(versionless), "{versionless}");
        }

        // Right shape, wrong host — including the two that a substring check would wave
        // through, where the real host is the *prefix* of a hostile one or its userinfo.
        for off_host in [
            "https://errors.scryfall.com/soon.jpg?17",
            "https://cards.scryfall.io.evil.test/grid/x.webp?17",
            "https://cards.scryfall.io@evil.test/grid/x.webp?17",
            "https://evil.test/https://cards.scryfall.io/grid/x.webp?17",
            "http://cards.scryfall.io/grid/x.webp?17",
        ] {
            assert!(has_cache_buster(off_host), "{off_host}");
            assert!(
                !is_image_host(off_host),
                "{off_host} must not read as the CDN"
            );
        }
    }

    /// [`FRONT_FACE_VARIANT`] is interpolated into a `json_extract` path, so it may only ever
    /// be one of the four names the ingest actually writes.
    ///
    /// Two failures in one: a name outside [`crate::schema::IMAGE_VARIANTS`] is a key no row
    /// has — every card would come back with no picture and nothing would error — and it is the
    /// only string in this module that reaches SQL unbound.
    #[test]
    fn the_front_face_variant_is_one_the_schema_stores() {
        assert!(
            crate::schema::IMAGE_VARIANTS.contains(&FRONT_FACE_VARIANT),
            "`{FRONT_FACE_VARIANT}` is not a column the ingest writes"
        );
    }

    /// The select list and the reader that folds it back up are one pairing, and the test
    /// runs them against real rows rather than asserting on the SQL text: the failure this
    /// guards is a mismatch between the two, which reads as *every card showing the wrong
    /// picture* and not as an error.
    #[test]
    fn the_front_face_selects_and_the_reader_agree_on_the_pairing() {
        let conn = seeded();
        let selects = front_face_selects("c").join(", ");
        assert_eq!(selects.matches("json_extract").count(), FRONT_FACE_COLUMNS);

        let uri = |id: &str| {
            conn.query_row(
                &format!("SELECT {selects} FROM cards c WHERE c.id = ?1"),
                params![id],
                |r| front_face_uri(|i| r.get::<_, Option<String>>(i)),
            )
            .unwrap()
        };

        // The plain printing, whose fixture carries all four variants: a path naming any other
        // one still reads a real URL, just not this one.
        assert_eq!(
            uri("bolt").as_deref(),
            Some("https://cards.scryfall.io/display/front/0/0/x.webp?17")
        );

        // The transform, whose picture is on its faces and not in a top-level blob at all.
        assert_eq!(
            uri("delver").as_deref(),
            Some("https://cards.scryfall.io/display/front/a/b/y.webp?9")
        );

        // And the precedence, through the whole pipeline this time. `meld` is the row where
        // top-level and face disagree, so a pair read in the wrong order — or a select list
        // emitted face-first — answers `top.webp` here.
        assert_eq!(
            uri("meld").as_deref(),
            Some("https://cards.scryfall.io/display/face0.webp?1")
        );
    }

    /// `soon.jpg` — the live poisoning — reaches a share snapshot the same way it reaches the
    /// cache, so it is refused in the same place.
    #[test]
    fn a_versionless_uri_is_no_image_at_all_rather_than_a_url() {
        let conn = seeded();
        // The live `mic 57` row: Scryfall's error page in every `image_uris` slot.
        conn.execute(
            "INSERT INTO cards (id, name, set_code, collector_number, lang, layout, image_uris, raw)
             VALUES ('soon','Ghouls'' Night Out','mic','57','en','normal',
                     json_object(
                       'thumb','https://errors.scryfall.com/soon.jpg',
                       'grid','https://errors.scryfall.com/soon.jpg',
                       'display','https://errors.scryfall.com/soon.jpg',
                       'art','https://errors.scryfall.com/soon.jpg'), '{}')",
            [],
        )
        .unwrap();

        let selects = front_face_selects("c").join(", ");
        let uri: Option<String> = conn
            .query_row(
                &format!("SELECT {selects} FROM cards c WHERE c.id = 'soon'"),
                [],
                |r| front_face_uri(|i| r.get::<_, Option<String>>(i)),
            )
            .unwrap();
        assert_eq!(uri, None, "an error page is a gap, not a picture");
    }
}
