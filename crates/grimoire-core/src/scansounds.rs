//! **The scanner's sounds** — whether a scan beeps, and the prices at which it plays something
//! louder. One `app_meta` row, written whole.
//!
//! Which sound plays for which card is the page's conclusion (`features/scanner/scanSounds.ts`):
//! it knows the tray row, its finish and its price. All Rust owns is the setting and the one rule
//! that keeps it a setting a page can act on — **the four thresholds climb**. A tier above the
//! jackpot, or two tiers at one figure, is a ladder with a rung no card could ever land on, and it
//! is refused where the reader can still fix it rather than stored to be argued with later.
//!
//! **The figures are in the marketplace's own currency**, whichever the reader quotes in —
//! dollars at TCGplayer, euros at Cardmarket. Nothing here converts: a threshold is "a card worth
//! this much at the prices I see", and the page compares it against exactly those prices.
//!
//! **Reading can never fail**, [`crate::startview`]'s rule: no row, a row that is not JSON, a
//! row of the wrong shape and a row whose figures do not climb all read as the defaults. A setting
//! that cannot be read is not worth a scanner that will not beep.
//!
//! No migration: `app_meta` is the application's key/value table (schema v6), and this is a key
//! in it. A fact about this device, like every `app_meta` row — no sync spec carries it.
use rusqlite::Connection;

/// The `app_meta` key.
pub const K_SCAN_SOUNDS: &str = "scan_sounds";

/// What [`store`] says when the four figures do not climb, or one is not a price at all.
pub const TIERS_MUST_CLIMB: &str =
    "Each price must be a positive amount, and each tier higher than the one before it.";

/// Whether the scanner plays a sound as a card lands, and the four prices its louder sounds start
/// at — each one "this card is worth at least this much".
///
/// `#[serde(default)]` on the struct, so a row written by an older or newer build with a field
/// more or less reads with the rest intact.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ScanSounds {
    /// Whether the scanner plays anything at all.
    pub enabled: bool,
    /// The first tier's floor — `$1` out of the box.
    pub tier1: f64,
    /// The second tier's floor — `$10`.
    pub tier2: f64,
    /// The third tier's floor — `$100`.
    pub tier3: f64,
    /// The jackpot's floor — `$1000`.
    pub jackpot: f64,
}

impl Default for ScanSounds {
    fn default() -> ScanSounds {
        ScanSounds {
            enabled: true,
            tier1: 1.0,
            tier2: 10.0,
            tier3: 100.0,
            jackpot: 1000.0,
        }
    }
}

impl ScanSounds {
    /// The four floors in climbing order.
    fn floors(&self) -> [f64; 4] {
        [self.tier1, self.tier2, self.tier3, self.jackpot]
    }

    /// Whether every floor is a positive, finite figure above the one below it.
    fn climbs(&self) -> bool {
        let floors = self.floors();
        floors.iter().all(|f| f.is_finite() && *f > 0.0) && floors.windows(2).all(|w| w[0] < w[1])
    }
}

/// The reader's scan sounds, or the defaults — see the module doc for why nothing here fails.
pub fn stored(conn: &Connection) -> ScanSounds {
    crate::app_meta::get_app_meta(conn, K_SCAN_SOUNDS)
        .and_then(|raw| serde_json::from_str::<ScanSounds>(&raw).ok())
        .filter(ScanSounds::climbs)
        .unwrap_or_default()
}

/// Remember the reader's scan sounds. **One refusal**, [`TIERS_MUST_CLIMB`]; the other arm is
/// SQLite's.
pub fn store(conn: &Connection, sounds: &ScanSounds) -> Result<(), String> {
    if !sounds.climbs() {
        return Err(TIERS_MUST_CLIMB.to_owned());
    }
    let json = serde_json::to_string(sounds)
        .map_err(|e| format!("could not save the scan sounds: {e}"))?;
    crate::app_meta::set_app_meta(conn, K_SCAN_SOUNDS, &json)
        .map_err(|e| format!("could not save the scan sounds: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_meta::set_app_meta;

    fn conn() -> Connection {
        crate::schema::memory_pair()
    }

    /// Spelled out rather than compared with `Default`, so moving a fresh install's ladder is a
    /// deliberate act.
    #[test]
    fn a_missing_row_reads_as_on_at_one_ten_a_hundred_and_a_thousand() {
        let s = stored(&conn());
        assert!(s.enabled);
        assert_eq!(s.floors(), [1.0, 10.0, 100.0, 1000.0]);
    }

    #[test]
    fn a_stored_setting_round_trips() {
        let c = conn();
        let s = ScanSounds {
            enabled: false,
            tier1: 0.5,
            tier2: 5.0,
            tier3: 50.0,
            jackpot: 250.0,
        };
        store(&c, &s).unwrap();
        assert_eq!(stored(&c), s);
    }

    #[test]
    fn a_ladder_that_does_not_climb_is_refused_and_nothing_is_written() {
        let c = conn();
        for bad in [
            ScanSounds {
                tier2: 1.0,
                ..ScanSounds::default()
            },
            ScanSounds {
                jackpot: 50.0,
                ..ScanSounds::default()
            },
            ScanSounds {
                tier1: 0.0,
                ..ScanSounds::default()
            },
            ScanSounds {
                tier1: -1.0,
                ..ScanSounds::default()
            },
            ScanSounds {
                tier3: f64::NAN,
                ..ScanSounds::default()
            },
            ScanSounds {
                jackpot: f64::INFINITY,
                ..ScanSounds::default()
            },
        ] {
            assert_eq!(store(&c, &bad), Err(TIERS_MUST_CLIMB.to_owned()), "{bad:?}");
        }
        assert_eq!(crate::app_meta::get_app_meta(&c, K_SCAN_SOUNDS), None);
    }

    /// Junk, and a row whose figures do not climb (hand-edited, or an older rule's), are the
    /// defaults — the read never fails.
    #[test]
    fn a_row_that_does_not_parse_or_does_not_climb_reads_as_the_default() {
        let c = conn();
        for junk in [
            "not json",
            "[]",
            r#"{"enabled":"yes"}"#,
            r#"{"tier1":10,"tier2":1}"#,
        ] {
            set_app_meta(&c, K_SCAN_SOUNDS, junk).unwrap();
            assert_eq!(stored(&c), ScanSounds::default(), "{junk}");
        }
    }

    /// A row missing a field keeps the rest: `#[serde(default)]` on the struct.
    #[test]
    fn a_row_with_a_field_missing_keeps_what_it_had() {
        let c = conn();
        set_app_meta(&c, K_SCAN_SOUNDS, r#"{"enabled":false,"tier1":2}"#).unwrap();
        let s = stored(&c);
        assert!(!s.enabled);
        assert_eq!(s.floors(), [2.0, 10.0, 100.0, 1000.0]);
    }
}
