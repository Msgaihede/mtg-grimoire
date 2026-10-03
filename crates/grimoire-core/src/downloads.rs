//! **What a launch would download right now, and roughly how much** — for the light app's
//! mobile-data prompt (phase 4, step 4.4; the light-app spec §4: *"Any feed over 5 MB shows its
//! measured size and, where the connection reports itself metered, defaults to Not now"*).
//!
//! A launch fetches five things uninvited, each on its own schedule: the card file (daily), the
//! selected marketplace's price feed (daily, and only a feed-backed one), both Tagger files and
//! Commander Spellbook's combos (weekly). Each module answers *is it due* with the rule its own
//! `refresh_if_due` uses, so this asks those and nothing of its own; what it adds is the size.
//!
//! **The sizes are measurements, not promises.** Each is the figure this repository measured
//! when the feed was built — the research docs and the module docs name the day — and a
//! download is free to have grown since. They are what a reader on a metered link is told, so
//! they are rounded up rather than down, and the prompt says *about*.
//!
//! **A due card sync may download nothing**: the check is a conditional request, and a file
//! Scryfall has not rotated since the last one costs a few hundred bytes. It is listed anyway,
//! because Scryfall rotates the file daily and the honest default on a metered link is to say
//! what it would cost when it does.

use rusqlite::Connection;
use serde::Serialize;

use crate::state::State;
use crate::{combos, marketplace_feed, sync, tags};

/// The size over which a download is worth asking about on a metered link — the spec's 5 MB.
pub const LARGE_BYTES: u64 = 5 * 1000 * 1000;

/// The card file, `default_cards` gzipped: 77 MB (`sync::already_ingested`'s doc).
pub const CARDS_BYTES: u64 = 77_000_000;
/// Scryfall's Oracle Tags: 5.85 MB (`docs/superpowers/research/2026-08-14-scryfall-oracle-tags.md`).
pub const ORACLE_TAGS_BYTES: u64 = 5_850_000;
/// Scryfall's Art Tags: 12.5 MB (`docs/superpowers/research/2026-08-20-scryfall-art-tags.md`).
pub const ART_TAGS_BYTES: u64 = 12_500_000;
/// Commander Spellbook's `variants.json.gz`: 27.5 MB (`docs/reference/commander-brackets.md`).
pub const COMBOS_BYTES: u64 = 27_500_000;
/// Card Kingdom's price list: 66 787 283 B, 63.7 MiB
/// (`docs/superpowers/research/2026-08-12-card-kingdom-mana-pool-price-feeds.md`).
pub const CARD_KINGDOM_BYTES: u64 = 66_787_283;
/// Mana Pool's price list: 50 741 864 B, 48.4 MiB (the same research).
pub const MANA_POOL_BYTES: u64 = 50_741_864;

/// One download a launch would start now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Due {
    /// Which one — `cards`, `prices`, `oracleTags`, `artTags` or `combos`.
    pub key: &'static str,
    /// What the reader is told it is.
    pub label: &'static str,
    /// About how many bytes it costs — see the module doc.
    pub bytes: u64,
}

/// Every download a launch would start now, in the order the launch starts them.
pub fn launch_due(state: &State) -> Vec<Due> {
    let now = crate::platform::clock::now_secs();
    let now_secs = u64::try_from(now).unwrap_or(0);
    let mut due = Vec::new();
    {
        let conn = state.lock_db_read();
        if cards_due(&conn, now_secs) {
            due.push(Due {
                key: "cards",
                label: "Card data from Scryfall",
                bytes: CARDS_BYTES,
            });
        }
        if let Some(marketplace) = marketplace_feed::selected_due(&conn, now) {
            due.push(Due {
                key: "prices",
                label: prices_label(&marketplace),
                bytes: prices_bytes(&marketplace),
            });
        }
        if combos::due_at_launch(&conn, now) {
            due.push(Due {
                key: "combos",
                label: "Combos from Commander Spellbook",
                bytes: COMBOS_BYTES,
            });
        }
    }
    // The tag datasets take the read connection themselves.
    if tags::due_at_launch(&tags::oracle::ORACLE, state, now) {
        due.push(Due {
            key: "oracleTags",
            label: "Card tags from Scryfall",
            bytes: ORACLE_TAGS_BYTES,
        });
    }
    if tags::due_at_launch(&tags::art::ART, state, now) {
        due.push(Due {
            key: "artTags",
            label: "Art tags from Scryfall",
            bytes: ART_TAGS_BYTES,
        });
    }
    due
}

/// Whether the launch's card sync would ask Scryfall now: a database with no cards always, and
/// otherwise when the daily check is due — `sync::should_check`, the run's own throttle.
fn cards_due(conn: &Connection, now: u64) -> bool {
    if !sync::has_cards(conn) {
        return true;
    }
    let last = sync::get_meta(conn, sync::K_LAST_CHECK_AT).and_then(|s| s.parse::<u64>().ok());
    sync::should_check(last, now, false)
}

fn prices_label(marketplace: &str) -> &'static str {
    match marketplace {
        "manapool" => "Mana Pool prices",
        _ => "Card Kingdom prices",
    }
}

fn prices_bytes(marketplace: &str) -> u64 {
    match marketplace {
        "manapool" => MANA_POOL_BYTES,
        _ => CARD_KINGDOM_BYTES,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A database that has never fetched anything owes every download but the price feed, which
    /// waits for a feed-backed marketplace to be chosen.
    #[test]
    fn a_first_launch_owes_the_cards_the_tags_and_the_combos() {
        let state = crate::state::fixtures::on_files("downloads-first", "http://127.0.0.1:9").0;
        let due = launch_due(&state);
        let keys: Vec<_> = due.iter().map(|d| d.key).collect();
        assert_eq!(keys, ["cards", "combos", "oracleTags", "artTags"]);
        assert!(
            due.iter().all(|d| d.bytes > LARGE_BYTES),
            "every one of them is worth asking about on a metered link"
        );
    }

    /// Choosing a feed-backed marketplace adds its feed, at its own size.
    #[test]
    fn a_feed_backed_marketplace_owes_its_price_list() {
        let state = crate::state::fixtures::on_files("downloads-prices", "http://127.0.0.1:9").0;
        {
            let conn = state.db.lock().unwrap();
            crate::marketplace::store(&conn, "manapool").unwrap();
        }
        let prices: Vec<_> = launch_due(&state)
            .into_iter()
            .filter(|d| d.key == "prices")
            .collect();
        assert_eq!(
            prices,
            [Due {
                key: "prices",
                label: "Mana Pool prices",
                bytes: MANA_POOL_BYTES
            }]
        );
    }

    /// A corpus checked an hour ago owes no card download.
    #[test]
    fn a_card_check_made_today_is_not_due() {
        let state = crate::state::fixtures::on_files("downloads-checked", "http://127.0.0.1:9").0;
        {
            let conn = state.db.lock().unwrap();
            conn.execute_batch(
                "INSERT INTO cards (id, oracle_id, name, set_code, set_name, collector_number,
                                    lang, layout, raw)
                   VALUES ('bolt', 'o1', 'Lightning Bolt', 'lea', 'Alpha', '161', 'en',
                           'normal', x'00');",
            )
            .unwrap();
            let now = crate::platform::clock::now_secs();
            sync::set_meta(&conn, sync::K_LAST_CHECK_AT, &(now - 3600).to_string()).unwrap();
        }
        assert!(!launch_due(&state).iter().any(|d| d.key == "cards"));
    }
}
