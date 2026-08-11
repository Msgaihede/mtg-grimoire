//! Scryfall JSONL card object -> one `cards` row.
//!
//! Pure parsing: no I/O, no database. The layout zoo is the whole difficulty here.
//! Measured against real `default_cards` data, the traps this module absorbs are:
//!
//! - `reversible_card` has **no** top-level `oracle_id`, `cmc`, `type_line` or
//!   `mana_cost` — they live in `card_faces[0]`, so every one of those reads falls
//!   back to the first face.
//! - `colors` is absent on cards whose colors are defined per face (transform,
//!   modal_dfc, reversible), so it falls back too. `color_identity` never does:
//!   it is a whole-card property and only ever appears at the top level.
//! - `meld` has top-level images and **no** `card_faces` at all; `transform`,
//!   `modal_dfc`, `double_faced_token` and `art_series` are the reverse — images per
//!   face and nothing at the top level. Both shapes are resolved here, into two
//!   columns that live data never fills at once, and a few hundred printings (art
//!   series, mostly) fill neither.
//! - `prices` values are decimal **strings** or `null`, never JSON numbers.
//! - `collector_number` is text (`"1★"`, `"99b"`, `"A-193"`) and `cmc` is decimal
//!   (`0.5` on un-cards), so neither may be narrowed to an integer.
//! - `games` — not `digital` — decides whether a printing is ownable on paper.

use serde_json::Value;

/// One row of `cards`. Field order mirrors the `cards` column list in [`crate::schema`].
#[derive(Debug, Clone)]
pub struct CardRow {
    pub id: String,
    pub oracle_id: Option<String>,
    pub name: String,
    pub lang: String,
    pub released_at: Option<String>,
    pub set_code: String,
    pub set_name: Option<String>,
    pub collector_number: String,
    pub rarity: Option<String>,
    pub layout: String,
    pub mana_cost: Option<String>,
    pub cmc: Option<f64>,
    pub type_line: Option<String>,
    pub oracle_text: Option<String>,
    pub colors: Option<String>,
    pub color_identity: Option<String>,
    pub legalities: Option<String>,
    /// [`crate::legalities`]' mask of the line above, a column of its own since v8: the
    /// format filter is a bitwise test rather than 23 `json_extract`s per row, and — the
    /// part no blob can do at any price — it can live in an index.
    pub legal_mask: u64,
    pub games: Option<String>,
    pub finishes: Option<String>,
    pub prices: Option<String>,
    pub price_usd: Option<f64>,
    pub price_eur: Option<f64>,
    pub faces: Option<String>,
    pub illustration_id: Option<String>,
    pub frame_effects: Option<String>,
    pub border_color: Option<String>,
    pub full_art: bool,
    pub promo: bool,
    pub promo_types: Option<String>,
    pub digital: bool,
    pub is_paper: bool,
    pub edhrec_rank: Option<i64>,
    pub game_changer: bool,
    pub image_status: Option<String>,
    pub image_updated_at: Option<String>,
    /// The four WEBP variants from the top-level `image_uris`, as compact JSON.
    /// `None` for the 3.7% of printings that have no top-level image object at all.
    pub image_uris: Option<String>,
    /// One entry per `card_faces[i]`: the same object, or JSON `null` for a face with no
    /// images. `None` when no face has any, which keeps `split`/`adventure`/`flip`
    /// (two faces, one physical side, images at the top level) out of the column.
    pub face_image_uris: Option<String>,
    /// Who drew it. A column of its own since v3: it is one short string per row, and
    /// reading it back out of `raw` on every card-detail query was the last thing keeping
    /// that blob in the hot path. Top level first, then the front face — a reversible card
    /// has no top-level artist.
    pub artist: Option<String>,
    /// The printed power and toughness, **as text**, columns of their own since v5.
    ///
    /// Text because that is what they are: `"*"`, `"1+*"`, `"7-*"` and `"∞"` all ship in
    /// real data, and `"0"` is a printed zero while absent means *no P/T box at all* — the
    /// distinction CR 903.3 turns on, since a Vehicle or Spacecraft **with a P/T box** can
    /// be a commander in 2026 and one without cannot. Same fallback as [`CardRow::artist`]:
    /// top level, then `card_faces[0]`, because a transform's P/T live only on its faces.
    pub power: Option<String>,
    pub toughness: Option<String>,
    pub search_text: String,
    /// The original bulk line, gzipped. `raw` is far and away the largest column in the
    /// database — 622 MB of it, measured live over 116 568 rows, in a `mtg.db` of 2 018 MB
    /// — and nothing reads it at runtime any more, so it is stored the way an archive is
    /// stored: gzip takes those 622 MB to roughly 236 MB. Written into a column *declared*
    /// `TEXT NOT NULL` — SQLite's TEXT affinity leaves a BLOB a BLOB, so the storage class
    /// is honest even though the declaration is v1's and frozen.
    pub raw: Vec<u8>,
}

/// A bulk line, gzipped for storage.
///
/// `Compression::fast` rather than the default, and this runs 116 568 times inside a sync
/// the user is watching. Measured over 5 828 real bulk lines: level 1 compresses 2.64:1 at
/// roughly **twice** the throughput of level 6, which manages 2.93:1 — so the default buys
/// about a tenth more ratio (236 MB against 212 MB across the corpus) for double the time.
/// Level 1 costs ~3.4 s over a full ingest; level 6 would cost ~7.1 s.
///
/// A compressor that somehow fails hands back the plain bytes — [`raw_json`] reads both,
/// so the fallback costs disk rather than correctness.
pub fn gzip_raw(line: &str) -> Vec<u8> {
    use std::io::Write;
    let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    if enc.write_all(line.as_bytes()).is_err() {
        return line.as_bytes().to_vec();
    }
    enc.finish().unwrap_or_else(|_| line.as_bytes().to_vec())
}

/// The stored `raw` bytes as JSON text, whichever way they were written.
///
/// A gzip member always begins `1f 8b`; a Scryfall card line always begins `{`. That is
/// the whole discriminator, and it is what lets a database that has migrated to v3 but not
/// yet synced — every row still plain text — be read by the same code as one that has.
///
/// Read the column with `CAST(raw AS BLOB)`: rusqlite will not hand a TEXT value out as
/// `Vec<u8>`, and the cast is free for a value that is already a BLOB.
pub fn raw_json(stored: &[u8]) -> Option<String> {
    use std::io::Read;
    if stored.starts_with(&[0x1f, 0x8b]) {
        let mut out = String::new();
        flate2::read::GzDecoder::new(stored)
            .read_to_string(&mut out)
            .ok()?;
        return Some(out);
    }
    String::from_utf8(stored.to_vec()).ok()
}

/// A string field, if present and actually a string.
fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_owned)
}

/// `["W","U"]` -> `"WU"`. Scryfall's color arrays are single letters, and the
/// concatenated form is what queries like `colors LIKE '%R%'` need.
fn joined_letters(v: &Value, k: &str) -> Option<String> {
    v.get(k)
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect::<String>())
}

/// Store an object/array field verbatim as compact JSON. Used for the fields whose
/// shape grows over time (`legalities` gained formats; `promo_types` is open-ended),
/// so a new Scryfall key never needs a migration.
fn compact(v: &Value, k: &str) -> Option<String> {
    v.get(k).filter(|x| !x.is_null()).map(|x| x.to_string())
}

/// The four WEBP variants of an object's `image_uris`, as a JSON object — `None` when
/// the object carries no `image_uris` at all.
///
/// Reduced rather than stored verbatim: Scryfall ships eleven keys, seven of them the
/// legacy JPG/PNG family its own docs mark as *replaced*. `raw` keeps the rest.
///
/// All four keys are always written, a variant the source lacks as JSON `null`, because
/// the v2 backfill builds the same object with `json_object('thumb', json_extract(…), …)`
/// and SQLite writes those nulls too. A backfilled row and an ingested row have to be the
/// same object for the same input — see
/// `schema::tests::the_backfill_and_the_ingest_agree_on_every_image_shape`. (The one
/// input the two would answer differently is an `image_uris` that is not an object at
/// all, which the API does not emit and which is better stored as nothing.)
fn webp_uris(o: &Value) -> Option<Value> {
    let uris = o.get("image_uris")?.as_object()?;
    let out = crate::schema::IMAGE_VARIANTS
        .iter()
        .map(|k| {
            let uri = uris.get(*k).and_then(Value::as_str);
            let uri = uri.map_or(Value::Null, |u| Value::String(u.to_owned()));
            ((*k).to_owned(), uri)
        })
        .collect();
    Some(Value::Object(out))
}

/// A price, which Scryfall sends as a decimal string (`"0.32"`) or `null` — never a
/// JSON number. `as_str` is therefore the only correct read: a numeric parse would
/// silently return `None` for every real price if the type ever flipped.
fn price(v: &Value, k: &str) -> Option<f64> {
    v.get("prices")?.get(k)?.as_str()?.parse().ok()
}

impl CardRow {
    /// The parse without a line to remember, where `raw` is the serialization of `v`.
    ///
    /// Test-only, and deliberately so: production reads a line and parses it, so it always
    /// has the verbatim bytes and must pass them. This exists because most of the parser's
    /// tests are about the *derived* columns and have no interest in `raw` — building the
    /// line back out of the `Value` keeps their call shape a single argument.
    #[cfg(test)]
    pub fn from_json(v: &Value) -> Option<CardRow> {
        CardRow::from_json_line(v, &v.to_string())
    }

    /// `None` => skip line (not a card object).
    ///
    /// `line` is borrowed, not moved. It used to be moved because it *became* the row's
    /// `raw` and copying 117 k lines of ~5 KB was half a gigabyte of pointless memcpy;
    /// since v3 `raw` is [`gzip_raw`]'s output — a buffer of its own either way — so
    /// taking ownership would buy nothing and only constrain the caller.
    ///
    /// It is the line the value was parsed *from*, not `v.to_string()`: serde re-orders
    /// and re-formats, and the column's promise is verbatim — gzipped, but verbatim.
    pub fn from_json_line(v: &Value, line: &str) -> Option<CardRow> {
        if v.get("object")?.as_str()? != "card" {
            return None;
        }
        let faces = v.get("card_faces").and_then(Value::as_array);
        let face0 = faces.and_then(|f| f.first());
        // Top level first, then the front face: the fallback that keeps reversible
        // cards (and anything else that moves fields onto faces) out of the skip pile.
        let pick = |k: &str| s(v, k).or_else(|| face0.and_then(|f| s(f, k)));
        let cmc = v
            .get("cmc")
            .and_then(Value::as_f64)
            .or_else(|| face0.and_then(|f| f.get("cmc")).and_then(Value::as_f64));
        let games: Vec<&str> = v
            .get("games")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();

        // The FTS haystack. Face name/type/text are folded in so a search for the back
        // half of a DFC ("Insectile Aberration") finds the printing it belongs to.
        let mut search_text = v
            .get("oracle_text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if let Some(fs) = faces {
            for f in fs {
                for k in ["name", "type_line", "oracle_text"] {
                    if let Some(t) = f.get(k).and_then(Value::as_str) {
                        search_text.push(' ');
                        search_text.push_str(t);
                    }
                }
            }
        }

        Some(CardRow {
            id: s(v, "id")?,
            oracle_id: pick("oracle_id"),
            name: s(v, "name")?,
            lang: s(v, "lang")?,
            released_at: s(v, "released_at"),
            set_code: s(v, "set")?,
            set_name: s(v, "set_name"),
            collector_number: s(v, "collector_number")?,
            rarity: s(v, "rarity"),
            layout: s(v, "layout")?,
            mana_cost: pick("mana_cost"),
            cmc,
            type_line: pick("type_line"),
            oracle_text: s(v, "oracle_text"),
            colors: joined_letters(v, "colors")
                .or_else(|| face0.and_then(|f| joined_letters(f, "colors"))),
            color_identity: joined_letters(v, "color_identity"),
            legalities: compact(v, "legalities"),
            legal_mask: v.get("legalities").map_or(0, crate::legalities::legal_mask),
            games: compact(v, "games"),
            finishes: compact(v, "finishes"),
            prices: compact(v, "prices"),
            // Foil-only and etched-only printings have a null `usd`; fall through so a
            // collection still shows a value for them.
            price_usd: price(v, "usd")
                .or_else(|| price(v, "usd_foil"))
                .or_else(|| price(v, "usd_etched")),
            price_eur: price(v, "eur").or_else(|| price(v, "eur_foil")),
            faces: compact(v, "card_faces"),
            illustration_id: s(v, "illustration_id"),
            frame_effects: compact(v, "frame_effects"),
            border_color: s(v, "border_color"),
            full_art: v.get("full_art").and_then(Value::as_bool).unwrap_or(false),
            promo: v.get("promo").and_then(Value::as_bool).unwrap_or(false),
            promo_types: compact(v, "promo_types"),
            digital: v.get("digital").and_then(Value::as_bool).unwrap_or(false),
            is_paper: games.contains(&"paper"),
            edhrec_rank: v.get("edhrec_rank").and_then(Value::as_i64),
            game_changer: v
                .get("game_changer")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            image_status: s(v, "image_status"),
            image_updated_at: s(v, "image_updated_at"),
            image_uris: webp_uris(v).map(|u| u.to_string()),
            // Per face index, never per card: `transform` and friends have two physical
            // sides and the URL path segment is `front`/`back` accordingly. Iterating
            // `card_faces` in order is what makes index 0 the front — the order is the
            // array's, not something reconstructed from the URLs. A face with no images
            // becomes a JSON `null` in place, so index 1 never silently resolves to
            // index 0's art, and a faces array with no images at all stays `None`.
            face_image_uris: faces.and_then(|fs| {
                let per: Vec<Value> = fs
                    .iter()
                    .map(|f| webp_uris(f).unwrap_or(Value::Null))
                    .collect();
                let any = per.iter().any(|x| !x.is_null());
                any.then(|| Value::Array(per).to_string())
            }),
            artist: pick("artist"),
            power: pick("power"),
            toughness: pick("toughness"),
            search_text,
            raw: gzip_raw(line),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn parse(line: &str) -> CardRow {
        CardRow::from_json(&serde_json::from_str(line).unwrap()).unwrap()
    }

    #[test]
    fn normal_card_maps_hot_columns() {
        let c = parse(
            r#"{"object":"card","id":"aaa","oracle_id":"ooo","name":"Lightning Bolt","lang":"en","layout":"normal","set":"lea","set_name":"Limited Edition Alpha","collector_number":"161","rarity":"common","cmc":1.0,"type_line":"Instant","oracle_text":"Deal 3 damage.","mana_cost":"{R}","colors":["R"],"color_identity":["R"],"legalities":{"vintage":"restricted"},"games":["paper"],"finishes":["nonfoil"],"prices":{"usd":"400.50","usd_foil":null,"usd_etched":null,"eur":"380.00","eur_foil":null,"tix":"1.2"},"digital":false}"#,
        );
        assert_eq!(c.name, "Lightning Bolt");
        assert_eq!(c.colors.as_deref(), Some("R"));
        assert_eq!(c.price_usd, Some(400.50));
        assert!(c.is_paper);
        assert!(c.search_text.contains("Deal 3 damage."));
    }

    #[test]
    fn reversible_card_tolerates_missing_top_level_fields() {
        let c = parse(
            r#"{"object":"card","id":"bbb","name":"Jinnie Fay // Jinnie Fay","lang":"en","layout":"reversible_card","set":"sld","collector_number":"1556","games":["paper"],"finishes":["foil"],"digital":false,"card_faces":[{"name":"Jinnie Fay","oracle_id":"o1","cmc":3.0,"type_line":"Legendary Creature","oracle_text":"Face text.","image_uris":{"grid":"u"}},{"name":"Jinnie Fay","oracle_id":"o2","type_line":"Legendary Creature"}]}"#,
        );
        assert_eq!(c.oracle_id.as_deref(), Some("o1")); // falls back to first face
        assert_eq!(c.cmc, Some(3.0));
        assert_eq!(c.type_line.as_deref(), Some("Legendary Creature"));
        assert!(c.search_text.contains("Face text."));
    }

    #[test]
    fn collector_number_star_and_fractional_cmc_survive() {
        let c = parse(
            r#"{"object":"card","id":"ccc","name":"Little Girl","lang":"en","layout":"normal","set":"unh","collector_number":"1★","cmc":0.5,"type_line":"Creature","games":["paper"],"finishes":["nonfoil"],"digital":false}"#,
        );
        assert_eq!(c.collector_number, "1★");
        assert_eq!(c.cmc, Some(0.5));
    }

    /// The ingest fills the mask natively, so the v8 backfill is only ever paid once — and
    /// a printing Scryfall gave no `legalities` at all masks to zero, which is legal
    /// nowhere and is an answer rather than a gap.
    #[test]
    fn a_parsed_row_carries_its_legality_mask() {
        let c = parse(
            r#"{"object":"card","id":"x","name":"Bolt","lang":"en","layout":"normal","set":"lea",
                "collector_number":"1","legalities":{"modern":"legal"},"games":["paper"]}"#,
        );
        assert_eq!(c.legal_mask, crate::legalities::bit("modern").unwrap());

        let none = parse(
            r#"{"object":"card","id":"y","name":"No Legalities","lang":"en","layout":"normal",
                "set":"lea","collector_number":"2","games":["paper"]}"#,
        );
        assert_eq!(none.legal_mask, 0);
    }

    #[test]
    fn non_card_object_returns_none() {
        assert!(CardRow::from_json(&serde_json::json!({"object":"error"})).is_none());
    }

    #[test]
    fn arena_only_card_is_not_paper() {
        let c = parse(
            r#"{"object":"card","id":"ddd","name":"A-Nadu","lang":"en","layout":"normal","set":"mh3","collector_number":"A-193","games":["arena"],"finishes":["nonfoil"],"digital":true}"#,
        );
        assert!(!c.is_paper);
        assert!(c.digital);
    }

    #[test]
    fn top_level_images_are_reduced_to_the_four_webp_variants() {
        let c = parse(
            r#"{"object":"card","id":"aaa","name":"Lightning Bolt","lang":"en","layout":"normal","set":"lea","collector_number":"161","games":["paper"],"finishes":["nonfoil"],"digital":false,"image_uris":{"small":"s.jpg","normal":"n.jpg","large":"l.jpg","png":"p.png","art_crop":"ac.jpg","border_crop":"bc.jpg","thumb":"t.webp","grid":"g.webp","display":"d.webp","art":"a.webp","crop":"c.webp"}}"#,
        );
        let uris: serde_json::Value =
            serde_json::from_str(c.image_uris.as_deref().unwrap()).unwrap();
        assert_eq!(uris["thumb"], "t.webp");
        assert_eq!(uris["grid"], "g.webp");
        assert_eq!(uris["display"], "d.webp");
        assert_eq!(uris["art"], "a.webp");
        assert_eq!(uris.as_object().unwrap().len(), 4, "WEBP only: {uris}");
        assert_eq!(c.face_image_uris, None);
    }

    /// The #1 image gotcha: transform / modal_dfc / double_faced_token / art_series /
    /// reversible_card carry no top-level `image_uris` at all, and a naive read blanks
    /// every double-faced card in the database.
    #[test]
    fn a_transform_carries_its_images_per_face() {
        let c = parse(
            r#"{"object":"card","id":"bbb","name":"Delver of Secrets // Insectile Aberration","lang":"en","layout":"transform","set":"isd","collector_number":"51","games":["paper"],"finishes":["nonfoil"],"digital":false,"card_faces":[{"name":"Delver of Secrets","image_uris":{"thumb":"f0t.webp","grid":"f0g.webp","display":"f0d.webp","art":"f0a.webp"}},{"name":"Insectile Aberration","image_uris":{"thumb":"f1t.webp","grid":"f1g.webp","display":"f1d.webp","art":"f1a.webp"}}]}"#,
        );
        assert_eq!(c.image_uris, None);
        let faces: serde_json::Value =
            serde_json::from_str(c.face_image_uris.as_deref().unwrap()).unwrap();
        assert_eq!(faces[0]["grid"], "f0g.webp");
        assert_eq!(faces[1]["grid"], "f1g.webp");
    }

    /// `split`, `adventure`, `flip` and `prepare` have two faces but one physical side:
    /// images live at the top level and the faces carry none. The face column must stay
    /// NULL rather than becoming `[null, null]`, because "no face images" and "faces with
    /// no images" are the same thing and only one of them is worth a row of storage.
    #[test]
    fn a_split_card_keeps_its_images_at_the_top_level() {
        let c = parse(
            r#"{"object":"card","id":"ccc","name":"Fire // Ice","lang":"en","layout":"split","set":"apc","collector_number":"128","games":["paper"],"finishes":["nonfoil"],"digital":false,"image_uris":{"thumb":"t.webp","grid":"g.webp","display":"d.webp","art":"a.webp"},"card_faces":[{"name":"Fire"},{"name":"Ice"}]}"#,
        );
        assert!(c.image_uris.is_some());
        assert_eq!(c.face_image_uris, None);
    }

    /// 6 of 105 art_series printings in the sample had images on neither the card nor its
    /// faces, and 162 printings have none anywhere in the live data. Both columns NULL is
    /// what the placeholder path keys on, so it has to be reachable.
    #[test]
    fn a_printing_with_no_images_anywhere_leaves_both_columns_null() {
        let c = parse(
            r#"{"object":"card","id":"ddd","name":"Nameless Art","lang":"en","layout":"art_series","set":"sld","collector_number":"1","games":["paper"],"finishes":["nonfoil"],"digital":false,"card_faces":[{"name":"Nameless Art"},{"name":"Nameless Art"}]}"#,
        );
        assert_eq!(c.image_uris, None);
        assert_eq!(c.face_image_uris, None);
    }

    /// One face imaged, one not — art_series again. The gap has to be a JSON `null` at
    /// the right index, not a shorter array, or face 1 would resolve to face 0's art.
    #[test]
    fn a_face_without_images_is_a_null_at_its_own_index() {
        let c = parse(
            r#"{"object":"card","id":"eee","name":"Half Art","lang":"en","layout":"art_series","set":"sld","collector_number":"2","games":["paper"],"finishes":["nonfoil"],"digital":false,"card_faces":[{"name":"Half Art"},{"name":"Half Art","image_uris":{"thumb":"t.webp","grid":"g.webp","display":"d.webp","art":"a.webp"}}]}"#,
        );
        let faces: serde_json::Value =
            serde_json::from_str(c.face_image_uris.as_deref().unwrap()).unwrap();
        assert!(faces[0].is_null(), "{faces}");
        assert_eq!(faces[1]["grid"], "g.webp");
    }

    /// Face order is positional, not emergent: `card_faces[0]` is the front, `[1]` the
    /// back, and the URL path segment (`/front/`, `/back/`) says so. Iterating the array
    /// in order is what makes that structural — a face read out of order would point the
    /// front of a transform at the back's art.
    #[test]
    fn face_order_follows_card_faces_order() {
        let c = parse(
            r#"{"object":"card","id":"fff","name":"Front // Back","lang":"en","layout":"transform","set":"isd","collector_number":"1","games":["paper"],"finishes":["nonfoil"],"digital":false,"card_faces":[{"name":"Front","image_uris":{"grid":"https://cards.scryfall.io/grid/front/f/f/fff.webp?1"}},{"name":"Back","image_uris":{"grid":"https://cards.scryfall.io/grid/back/f/f/fff.webp?1"}}]}"#,
        );
        let faces: serde_json::Value =
            serde_json::from_str(c.face_image_uris.as_deref().unwrap()).unwrap();
        assert!(
            faces[0]["grid"].as_str().unwrap().contains("/front/"),
            "{faces}"
        );
        assert!(
            faces[1]["grid"].as_str().unwrap().contains("/back/"),
            "{faces}"
        );
    }

    /// Parity with the v2 backfill, which builds the same object with
    /// `json_object('thumb', json_extract(…), …)` and so always writes four keys, a
    /// missing variant among them as JSON `null`. Dropping absent keys here instead would
    /// make a backfilled row and an ingested row two different objects for one input —
    /// see `schema::tests::the_backfill_and_the_ingest_agree_on_every_image_shape`.
    #[test]
    fn a_variant_missing_from_the_source_is_an_explicit_null_key() {
        let c = parse(
            r#"{"object":"card","id":"ggg","name":"Partial","lang":"en","layout":"normal","set":"x","collector_number":"1","games":["paper"],"finishes":["nonfoil"],"digital":false,"image_uris":{"grid":"g.webp","normal":"n.jpg"}}"#,
        );
        let uris: serde_json::Value =
            serde_json::from_str(c.image_uris.as_deref().unwrap()).unwrap();
        assert_eq!(uris["grid"], "g.webp");
        assert_eq!(uris.as_object().unwrap().len(), 4, "{uris}");
        for k in ["thumb", "display", "art"] {
            assert!(uris[k].is_null(), "{k} must be an explicit null: {uris}");
        }
    }

    /// The fixture shared with the ingest test. Its lines are full-shape Scryfall
    /// objects, so parsing them here is what proves the fallbacks work on real data
    /// rather than on the trimmed literals above.
    fn fixture_rows() -> Vec<CardRow> {
        let sample = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/cards_sample.jsonl"
        ))
        .unwrap();
        sample
            .lines()
            .enumerate()
            .map(|(i, line)| {
                let v: Value = serde_json::from_str(line)
                    .unwrap_or_else(|e| panic!("fixture line {} is not valid JSON: {e}", i + 1));
                CardRow::from_json(&v)
                    .unwrap_or_else(|| panic!("fixture line {} did not parse as a card", i + 1))
            })
            .collect()
    }

    fn row<'a>(rows: &'a [CardRow], name: &str) -> &'a CardRow {
        rows.iter()
            .find(|r| r.name.starts_with(name))
            .unwrap_or_else(|| panic!("no fixture row named {name}"))
    }

    /// Task 6 ingests this file and asserts `inserted == lines.len()`, so a line that
    /// silently returns `None` must fail here — in the parser's own tests — not there.
    #[test]
    fn every_fixture_line_parses_and_covers_the_layout_zoo() {
        let rows = fixture_rows();
        assert_eq!(rows.len(), 11, "fixture must stay at 11 lines");

        // The eleventh line is Rhystic Study (cm1 15), and it is there for one field: it is
        // the only printing in the fixture that publishes `"game_changer": true`. The
        // Commander bracket estimate reads nothing else, and the flag can only ever come
        // from a sync — the Commander Format Panel maintains the list — so the parser
        // answering `true` here is where that claim starts.
        assert!(row(&rows, "Rhystic Study").game_changer);
        assert!(
            !row(&rows, "Lightning Bolt").game_changer,
            "absent key is false"
        );
        assert!(
            !row(&rows, "Ragnarok").game_changer,
            "printed false stays false"
        );

        let layouts: Vec<&str> = rows.iter().map(|r| r.layout.as_str()).collect();
        for want in [
            "normal",
            "transform",
            "reversible_card",
            "meld",
            "split",
            "art_series",
        ] {
            assert!(layouts.contains(&want), "fixture must cover layout {want}");
        }
        for r in &rows {
            assert!(!r.id.is_empty() && !r.name.is_empty() && !r.set_code.is_empty());
        }
    }

    #[test]
    fn fixture_layout_gotchas_map_as_expected() {
        let rows = fixture_rows();

        // transform: no top-level colors, oracle_text or mana_cost — all on the faces.
        let delver = row(&rows, "Delver of Secrets");
        assert_eq!(delver.colors.as_deref(), Some("U"), "colors from face 0");
        assert_eq!(delver.mana_cost.as_deref(), Some("{U}"), "cost from face 0");
        assert!(delver.oracle_text.is_none());
        assert!(
            delver.search_text.contains("Insectile Aberration"),
            "the back face must be searchable"
        );

        // reversible_card: no top-level oracle_id/cmc/type_line at all.
        let jinnie = row(&rows, "Jinnie Fay");
        assert!(jinnie.oracle_id.is_some() && jinnie.cmc == Some(3.0));
        assert!(jinnie.type_line.is_some());

        // meld: top-level everything, and no `card_faces` to fall back to.
        let ragnarok = row(&rows, "Ragnarok");
        assert!(ragnarok.faces.is_none(), "meld carries no card_faces");
        assert_eq!(
            ragnarok.type_line.as_deref(),
            Some("Legendary Creature — Eidolon")
        );

        // split: one physical card, two faces, no top-level oracle_text.
        let fire = row(&rows, "Fire // Ice");
        assert!(fire.oracle_text.is_none());
        assert!(fire.search_text.contains("Tap target permanent."));

        // etched-only: `usd` is null, so the price must fall through to `usd_etched`,
        // and `eur_etched` does not exist in real data at all.
        let miara = row(&rows, "Miara");
        assert_eq!(miara.price_usd, Some(0.71));
        assert_eq!(miara.price_eur, None);
        assert_eq!(miara.finishes.as_deref(), Some(r#"["etched"]"#));

        // P/T, the pair CR 903.3 turns on: printed at the top level on a normal creature,
        // only on `card_faces[0]` for a transform (a naive top-level read blanks every
        // double-faced creature in the database), and absent on anything with no P/T box —
        // which is the *answer*, not a gap, so it may never become a zero.
        assert_eq!(
            (miara.power.as_deref(), miara.toughness.as_deref()),
            (Some("2"), Some("1"))
        );
        assert_eq!(
            (delver.power.as_deref(), delver.toughness.as_deref()),
            (Some("1"), Some("1")),
            "a transform's P/T are on its front face"
        );

        // Un-card: half a mana symbol, so `cmc` cannot be an integer.
        assert_eq!(row(&rows, "Little Girl").cmc, Some(0.5));

        // ★ collector number, and a basic land's empty `colors` array.
        let forest = row(&rows, "Forest");
        assert_eq!(forest.collector_number, "1★");
        assert!(forest.promo);
        assert_eq!(forest.colors.as_deref(), Some(""), "[] stays colorless");
        assert_eq!(
            (&forest.power, &forest.toughness),
            (&None, &None),
            "a land has no P/T box, which is an answer and not a gap"
        );

        // Alchemy rebalance: digital-only, so not ownable on paper, and unpriced.
        let alchemy = row(&rows, "A-Alrund's Epiphany");
        assert!(alchemy.digital && !alchemy.is_paper);
        assert_eq!(alchemy.price_usd, None);

        // art_series: images on neither face, `type_line` missing from one of them.
        let art = row(&rows, "Sheoldred");
        assert_eq!(art.image_status.as_deref(), Some("missing"));
        assert!(art.full_art);
        assert_eq!(art.type_line.as_deref(), Some("Card"));
    }

    /// The fixture is the only place the three image populations meet real Scryfall
    /// objects — eleven-key `image_uris` at the top level, per-face objects on the
    /// double-faced lines, and nothing at all on the art series. If a line ever loses its
    /// image keys, every ingest test that reads them still passes while covering nothing.
    #[test]
    fn the_fixture_covers_all_three_image_populations() {
        let rows = fixture_rows();
        let json =
            |s: &Option<String>| -> Value { serde_json::from_str(s.as_ref().unwrap()).unwrap() };

        // Top level only: `normal`, `meld`, and `split` (two faces, one physical side).
        for name in ["Lightning Bolt", "Ragnarok", "Fire // Ice"] {
            let r = row(&rows, name);
            let uris = json(&r.image_uris);
            assert_eq!(uris.as_object().unwrap().len(), 4, "{name}: {uris}");
            for k in crate::schema::IMAGE_VARIANTS {
                let u = uris[k]
                    .as_str()
                    .unwrap_or_else(|| panic!("{name} has no {k}: {uris}"));
                assert!(u.contains(&format!("/{k}/")) && u.contains(".webp"), "{u}");
            }
            assert!(r.face_image_uris.is_none(), "{name} has no face images");
        }

        // Per face only: `transform` and `reversible_card`, front then back.
        for name in ["Delver of Secrets", "Jinnie Fay"] {
            let r = row(&rows, name);
            assert!(r.image_uris.is_none(), "{name} has no top-level images");
            let faces = json(&r.face_image_uris);
            assert_eq!(faces.as_array().unwrap().len(), 2, "{name}: {faces}");
            assert!(faces[0]["grid"].as_str().unwrap().contains("/front/"));
            assert!(faces[1]["grid"].as_str().unwrap().contains("/back/"));
        }

        // Neither: the art series printing, which is what the placeholder path keys on.
        let art = row(&rows, "Sheoldred");
        assert_eq!((&art.image_uris, &art.face_image_uris), (&None, &None));
    }

    /// The column is declared `TEXT NOT NULL` by a frozen v1 constant and now holds gzip.
    /// SQLite's TEXT affinity converts *numbers* to text and leaves a BLOB alone, so the
    /// storage class stays honest — and this is the test that says so, because the failure
    /// mode of the alternative (silent UTF-8 mangling of a compressed stream) is a `raw`
    /// column that no longer decompresses.
    #[test]
    fn raw_is_stored_as_a_blob_and_reads_back_byte_for_byte() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();
        let line = r#"{"object":"card","id":"x","name":"Lightning Bolt","lang":"en","layout":"normal","set":"lea","collector_number":"161","artist":"Christopher Rush"}"#;
        let row = CardRow::from_json_line(&serde_json::from_str(line).unwrap(), line).unwrap();
        conn.execute(
            "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,artist,raw)
             VALUES (?1,?2,'lea','161','en','normal',?3,?4)",
            rusqlite::params![row.id, row.name, row.artist, row.raw],
        )
        .unwrap();

        let (kind, stored): (String, Vec<u8>) = conn
            .query_row(
                "SELECT typeof(raw), CAST(raw AS BLOB) FROM cards WHERE id='x'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(kind, "blob", "a gzip member must not be stored as text");
        assert_eq!(raw_json(&stored).as_deref(), Some(line), "verbatim, still");
        assert_eq!(row.artist.as_deref(), Some("Christopher Rush"));
        // The weak form of the claim: this sample line is far too short to reach the
        // 2.64:1 measured across 5 828 real bulk lines (gzip's header alone is 18 bytes),
        // so all that is checked here is that compression happened at all.
        assert!(row.raw.len() < line.len(), "compressed, not merely wrapped");
    }

    /// A database that has migrated to v3 but has not synced yet holds plain-text `raw` in
    /// every row, and the same reader has to serve both.
    #[test]
    fn raw_json_reads_a_row_written_before_the_gzip_switch() {
        let line = r#"{"object":"card","name":"Lightning Bolt"}"#;
        assert_eq!(raw_json(line.as_bytes()).as_deref(), Some(line));
        assert_eq!(raw_json(&gzip_raw(line)).as_deref(), Some(line));
        assert_eq!(raw_json(&[0x1f, 0x8b, 0x00, 0x01]), None, "truncated gzip");
    }
}
