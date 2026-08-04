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
//!   `modal_dfc`, `double_faced_token` and `art_series` are the reverse. Neither
//!   shape is decoded here (images are resolved downstream) but both must parse.
//! - `prices` values are decimal **strings** or `null`, never JSON numbers.
//! - `collector_number` is text (`"1★"`, `"99b"`, `"A-193"`) and `cmc` is decimal
//!   (`0.5` on un-cards), so neither may be narrowed to an integer.
//! - `games` — not `digital` — decides whether a printing is ownable on paper.

use serde_json::Value;

/// One row of `cards`, minus `raw` (the ingest carries the original line separately).
/// Field order mirrors the `cards` column list in [`crate::schema`].
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
    pub search_text: String,
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

/// A price, which Scryfall sends as a decimal string (`"0.32"`) or `null` — never a
/// JSON number. `as_str` is therefore the only correct read: a numeric parse would
/// silently return `None` for every real price if the type ever flipped.
fn price(v: &Value, k: &str) -> Option<f64> {
    v.get("prices")?.get(k)?.as_str()?.parse().ok()
}

impl CardRow {
    /// None => skip line (not a card object)
    pub fn from_json(v: &Value) -> Option<CardRow> {
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
            search_text,
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
}
