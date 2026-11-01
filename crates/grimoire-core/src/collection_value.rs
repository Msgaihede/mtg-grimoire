//! **What the reader's collection would fetch** — the share of a card's price they expect to get
//! for it, and the price under which a card is not worth selling at all. One `app_meta` row,
//! written whole.
//!
//! The reduced price is the page's conclusion (`(full − below) × sellPercent / 100`): Rust supplies
//! the facts it is drawn from and never does the sum. **The sell percentage never reaches SQL**;
//! only the minimum does, because a minimum is compared per card and only the statement that
//! prices the cards can do that ([`crate::collection::BelowMinimum`]). All this module owns is the
//! setting and the rule that keeps it one a page can act on — **a percentage of nothing is no
//! price, and neither is a minimum below zero** — refused where the reader can still fix it rather
//! than stored to be argued with later.
//!
//! **The minimum is in the marketplace's own currency**, whichever the reader quotes in — dollars
//! at TCGplayer, euros at Cardmarket. Nothing here converts: it means "a card worth less than this
//! at the prices I see", and it is compared against exactly those prices.
//!
//! **Reading can never fail**, [`crate::startview`]'s rule: no row, a row that is not JSON, a row
//! of the wrong shape and a row whose figures are out of bounds all read as the defaults, which
//! reduce nothing. A setting that cannot be read is not worth a collection page with no value on
//! it.
//!
//! No migration: `app_meta` is the application's key/value table (schema v6), and this is a key
//! in it. A fact about this device, like every `app_meta` row — no sync spec carries it.
use rusqlite::Connection;

/// The `app_meta` key.
pub const K_COLLECTION_VALUE: &str = "collection_value";

/// What [`store`] says when a figure is out of bounds, or is not a figure at all.
pub const OUT_OF_BOUNDS: &str =
    "Sell percentage has to be above 0 and at most 100, and the minimum card value can't be below zero.";

/// What a reader expects to get for the collection: this share of the price, for the cards priced
/// at this much or more.
///
/// `#[serde(default)]` on the struct, so a row written by an older or newer build with a field
/// more or less reads with the rest intact.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CollectionValue {
    /// The share of a card's price the reader expects to get — `100` out of the box, the full
    /// price.
    pub sell_percent: f64,
    /// The price a copy has to reach to be counted at all — `0` out of the box, every priced copy.
    /// A copy priced exactly here counts.
    pub minimum_value: f64,
}

impl Default for CollectionValue {
    fn default() -> CollectionValue {
        CollectionValue {
            sell_percent: 100.0,
            minimum_value: 0.0,
        }
    }
}

impl CollectionValue {
    /// Whether both figures are finite and inside their bounds. `sell_percent` is above zero
    /// rather than at least one, so a reader's `0.5` is a setting and only `0` is refused.
    fn valid(&self) -> bool {
        self.sell_percent.is_finite()
            && self.minimum_value.is_finite()
            && self.sell_percent > 0.0
            && self.sell_percent <= 100.0
            && self.minimum_value >= 0.0
    }
}

/// The reader's setting, or the defaults — see the module doc for why nothing here fails.
pub fn stored(conn: &Connection) -> CollectionValue {
    crate::app_meta::get_app_meta(conn, K_COLLECTION_VALUE)
        .and_then(|raw| serde_json::from_str::<CollectionValue>(&raw).ok())
        .filter(CollectionValue::valid)
        .unwrap_or_default()
}

/// Remember the reader's setting. **One refusal**, [`OUT_OF_BOUNDS`]; the other arm is SQLite's.
pub fn store(conn: &Connection, settings: &CollectionValue) -> Result<(), String> {
    if !settings.valid() {
        return Err(OUT_OF_BOUNDS.to_owned());
    }
    let json = serde_json::to_string(settings)
        .map_err(|e| format!("could not save the collection value settings: {e}"))?;
    crate::app_meta::set_app_meta(conn, K_COLLECTION_VALUE, &json)
        .map_err(|e| format!("could not save the collection value settings: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_meta::set_app_meta;

    fn conn() -> Connection {
        crate::schema::memory_pair()
    }

    /// Spelled out rather than compared with `Default`, so moving a fresh install's figures — which
    /// are what make the reduced price the full one — is a deliberate act.
    #[test]
    fn a_missing_row_reads_as_the_full_price_of_every_card() {
        let s = stored(&conn());
        assert_eq!(s.sell_percent, 100.0);
        assert_eq!(s.minimum_value, 0.0);
    }

    #[test]
    fn a_stored_setting_round_trips() {
        let c = conn();
        let s = CollectionValue {
            sell_percent: 70.0,
            minimum_value: 0.25,
        };
        store(&c, &s).unwrap();
        assert_eq!(stored(&c), s);
    }

    /// The bounds' own edges are settings: the whole price, the smallest share that is still a
    /// share, and a minimum of nothing.
    #[test]
    fn the_edges_of_the_bounds_are_settings() {
        let c = conn();
        for s in [
            CollectionValue {
                sell_percent: 100.0,
                minimum_value: 0.0,
            },
            CollectionValue {
                sell_percent: 0.5,
                minimum_value: 1000.0,
            },
        ] {
            store(&c, &s).unwrap();
            assert_eq!(stored(&c), s);
        }
    }

    #[test]
    fn a_figure_out_of_bounds_is_refused_and_nothing_is_written() {
        let c = conn();
        for bad in [
            CollectionValue {
                sell_percent: 0.0,
                ..CollectionValue::default()
            },
            CollectionValue {
                sell_percent: -1.0,
                ..CollectionValue::default()
            },
            CollectionValue {
                sell_percent: 100.5,
                ..CollectionValue::default()
            },
            CollectionValue {
                sell_percent: f64::NAN,
                ..CollectionValue::default()
            },
            CollectionValue {
                sell_percent: f64::INFINITY,
                ..CollectionValue::default()
            },
            CollectionValue {
                minimum_value: -0.01,
                ..CollectionValue::default()
            },
            CollectionValue {
                minimum_value: f64::NAN,
                ..CollectionValue::default()
            },
            CollectionValue {
                minimum_value: f64::INFINITY,
                ..CollectionValue::default()
            },
        ] {
            assert_eq!(store(&c, &bad), Err(OUT_OF_BOUNDS.to_owned()), "{bad:?}");
        }
        assert_eq!(crate::app_meta::get_app_meta(&c, K_COLLECTION_VALUE), None);
    }

    /// Junk, and a row whose figures are out of bounds (hand-edited, or an older rule's), are the
    /// defaults — the read never fails.
    #[test]
    fn a_row_that_does_not_parse_or_is_out_of_bounds_reads_as_the_default() {
        let c = conn();
        for junk in [
            "not json",
            "[]",
            r#"{"sellPercent":"half"}"#,
            r#"{"sellPercent":0}"#,
            r#"{"sellPercent":150}"#,
            r#"{"minimumValue":-1}"#,
        ] {
            set_app_meta(&c, K_COLLECTION_VALUE, junk).unwrap();
            assert_eq!(stored(&c), CollectionValue::default(), "{junk}");
        }
    }

    /// A row missing a field keeps the rest: `#[serde(default)]` on the struct.
    #[test]
    fn a_row_with_a_field_missing_keeps_what_it_had() {
        let c = conn();
        set_app_meta(&c, K_COLLECTION_VALUE, r#"{"sellPercent":70}"#).unwrap();
        let s = stored(&c);
        assert_eq!(s.sell_percent, 70.0);
        assert_eq!(s.minimum_value, 0.0);
    }

    /// The names `packages/ui/lib/ipc.ts` reads, and the row's own.
    #[test]
    fn the_setting_serialises_under_the_names_the_page_reads() {
        assert_eq!(
            serde_json::to_value(CollectionValue::default()).unwrap(),
            serde_json::json!({ "sellPercent": 100.0, "minimumValue": 0.0 })
        );
    }
}
