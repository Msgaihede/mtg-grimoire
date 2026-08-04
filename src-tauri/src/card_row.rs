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
    pub search_text: String,
    /// The original bulk line, stored verbatim so every field this schema does not model
    /// yet stays recoverable without a re-download. Owned by the row rather than passed
    /// beside it, because the batch that carries it to the database outlives the loop
    /// iteration that read it.
    pub raw: String,
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
        CardRow::from_json_line(v, v.to_string())
    }

    /// `None` => skip line (not a card object).
    ///
    /// `line` is taken **by value**: it is the row's `raw`, the caller has no use for it
    /// afterwards, and a full ingest moves 117 k of them at ~5 KB each — half a gigabyte
    /// of memcpy to copy what was about to be dropped.
    ///
    /// It is also the line the value was parsed *from*, not `v.to_string()`: serde
    /// re-orders and re-formats, and the column's promise is verbatim.
    pub fn from_json_line(v: &Value, line: String) -> Option<CardRow> {
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
            search_text,
            raw: line,
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
        assert_eq!(rows.len(), 10, "fixture must stay at 10 lines");

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

        // Un-card: half a mana symbol, so `cmc` cannot be an integer.
        assert_eq!(row(&rows, "Little Girl").cmc, Some(0.5));

        // ★ collector number, and a basic land's empty `colors` array.
        let forest = row(&rows, "Forest");
        assert_eq!(forest.collector_number, "1★");
        assert!(forest.promo);
        assert_eq!(forest.colors.as_deref(), Some(""), "[] stays colorless");

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
}
