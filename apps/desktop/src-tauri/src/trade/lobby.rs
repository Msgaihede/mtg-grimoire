//! **A trade over a lobby**: two readers, each on their own app, building one trade between
//! them — the same lobby a pod draft and a Playtesting game meet in (`crate::draft::lobby`, a
//! lobby of [`LobbyKind::Trade`]), with the relay's object unchanged and knowing nothing of it.
//!
//! **Each reader keeps their own copy of the trade**, an ordinary open trade on their own device
//! (`LobbyTrade::trade_id`): their side is what they offer, edited as any trade is, and the other
//! side is what the other reader offers, written into it by this app ([`replace_side`]) each time
//! their offer moves. What crosses is printings, finishes and counts ([`TradeOfferLine`]) — each
//! app reads them in its own card data and prices them in its own marketplace, as a guest's deck
//! is read in the host's (`crate::playtest::lobby`).
//!
//! **The host's app holds the deal** ([`TradeDeal`]): both offers, a revision that moves with
//! either, and whether each reader has accepted it. A guest's offer and acceptance are sent to
//! the host, which answers every change with the whole deal; an acceptance names the revision it
//! accepts, so one made before the other side last moved accepts nothing. **When both have
//! accepted the same revision the deal is agreed** and the lobby says so; each reader then
//! finishes their own copy of the trade with Finish trade, choosing what it does to their own
//! collection and wishlist exactly as they would for a trade made at a table.
//!
//! **A trade's lobby holds two people.** The host locks it once the other reader has joined, so
//! nobody else can, and removes a second guest who raced the lock in.
//!
//! [`LobbyKind::Trade`]: crate::draft::lobby::LobbyKind
//! [`replace_side`]: grimoire_core::trade::replace_side

use grimoire_core::trade::{TradeOfferLine, MAX_QUANTITY};
use serde::{Deserialize, Serialize};

/// The most lines one reader may offer over a lobby: the whole deal, both sides of it, has to
/// fit the relay's 64 KiB frame, and a line is about seventy bytes of JSON.
pub const MAX_OFFER_LINES: usize = 300;
/// The longest printing id that crosses: a Scryfall id is 36 characters.
const MAX_CARD_ID_CHARS: usize = 64;

/// What the two readers have put on the table, as the host's app holds it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeDeal {
    /// Moves with every change to either offer, so an acceptance can say which deal it took.
    pub rev: u64,
    /// What the host offers.
    pub host: Vec<TradeOfferLine>,
    /// What the guest offers.
    pub guest: Vec<TradeOfferLine>,
    pub host_accepted: bool,
    pub guest_accepted: bool,
}

impl TradeDeal {
    /// Both readers have accepted this revision.
    pub fn agreed(&self) -> bool {
        self.host_accepted && self.guest_accepted
    }

    /// One side's offer set to `lines`: `true` when it moved, which takes back both
    /// acceptances — each was of a deal that is no longer on the table. An offer sent again
    /// unchanged moves nothing, so a page that sends its side on every render accepts nothing
    /// away.
    pub fn offer(&mut self, host: bool, lines: Vec<TradeOfferLine>) -> bool {
        let side = if host {
            &mut self.host
        } else {
            &mut self.guest
        };
        if *side == lines {
            return false;
        }
        *side = lines;
        self.rev += 1;
        self.host_accepted = false;
        self.guest_accepted = false;
        true
    }

    /// One reader accepts revision `rev` (or takes an acceptance back): `true` when it counted.
    /// An acceptance of any other revision is of a deal that has since moved, and counts for
    /// nothing; an agreed deal is final.
    pub fn accept(&mut self, host: bool, rev: u64, yes: bool) -> bool {
        if rev != self.rev || self.agreed() {
            return false;
        }
        let mark = if host {
            &mut self.host_accepted
        } else {
            &mut self.guest_accepted
        };
        if *mark == yes {
            return false;
        }
        *mark = yes;
        true
    }

    /// What the other reader offers, from `host`'s seat or the guest's.
    pub fn theirs(&self, host: bool) -> &[TradeOfferLine] {
        if host {
            &self.guest
        } else {
            &self.host
        }
    }
}

/// This app's side of a trade's lobby, in its [`LobbyState`](crate::draft::lobby::LobbyState).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LobbyTrade {
    /// This reader's copy of the trade, on this device: their offer is its `mine` side, the
    /// other reader's its `theirs`.
    pub trade_id: Option<i64>,
    pub deal: TradeDeal,
    /// How many lines of the other reader's offer name a printing this app's card data does not
    /// have, and so are not on this copy of the trade.
    pub unknown: u32,
}

/// An offer as it arrived, made safe to hold and to write: at most [`MAX_OFFER_LINES`] lines,
/// each with an id of a sane length and `1..=`[`MAX_QUANTITY`] copies, one per printing and
/// finish. What does not pass is dropped, never the rest — the finish is checked again, as a
/// word this app knows, by the write.
pub fn tidy(lines: Vec<TradeOfferLine>) -> Vec<TradeOfferLine> {
    let mut out: Vec<TradeOfferLine> = Vec::new();
    for line in lines {
        let id_ok = !line.card_id.is_empty() && line.card_id.chars().count() <= MAX_CARD_ID_CHARS;
        if !id_ok || !(1..=MAX_QUANTITY).contains(&line.quantity) {
            continue;
        }
        match out
            .iter()
            .position(|o| o.card_id == line.card_id && o.finish == line.finish)
        {
            Some(n) => out[n].quantity = (out[n].quantity + line.quantity).min(MAX_QUANTITY),
            None if out.len() < MAX_OFFER_LINES => out.push(line),
            None => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(card_id: &str, quantity: i64) -> TradeOfferLine {
        TradeOfferLine {
            card_id: card_id.into(),
            finish: "nonfoil".into(),
            quantity,
        }
    }

    #[test]
    fn a_moved_offer_takes_back_both_acceptances_and_the_same_offer_again_moves_nothing() {
        let mut deal = TradeDeal::default();
        assert!(deal.offer(true, vec![line("bolt", 1)]));
        assert_eq!(deal.rev, 1);
        assert!(deal.accept(true, 1, true));
        assert!(deal.accept(false, 1, true));
        assert!(deal.agreed());

        let mut moving = TradeDeal {
            guest_accepted: false,
            ..deal.clone()
        };
        assert!(!moving.offer(true, vec![line("bolt", 1)]), "unchanged");
        assert!(
            moving.host_accepted,
            "an unchanged offer keeps the acceptance"
        );
        assert!(moving.offer(false, vec![line("goyf", 2)]));
        assert_eq!(moving.rev, 2);
        assert!(!moving.host_accepted && !moving.guest_accepted);
        assert_eq!(moving.theirs(true), [line("goyf", 2)]);
        assert_eq!(moving.theirs(false), [line("bolt", 1)]);
    }

    #[test]
    fn an_acceptance_counts_only_for_the_revision_on_the_table_and_an_agreed_deal_is_final() {
        let mut deal = TradeDeal::default();
        deal.offer(false, vec![line("bolt", 1)]);
        assert!(!deal.accept(true, 0, true), "a deal that has since moved");
        assert!(deal.accept(true, 1, true));
        assert!(!deal.accept(true, 1, true), "already accepted");
        assert!(deal.accept(true, 1, false), "taken back");
        assert!(deal.accept(true, 1, true));
        assert!(deal.accept(false, 1, true));
        assert!(deal.agreed());
        assert!(!deal.accept(false, 1, false), "an agreed deal is final");
        assert!(deal.agreed());
    }

    #[test]
    fn an_offer_is_tidied_to_lines_this_app_can_hold() {
        let long = "x".repeat(65);
        let mut many: Vec<TradeOfferLine> = (0..MAX_OFFER_LINES + 5)
            .map(|n| line(&format!("c{n}"), 1))
            .collect();
        many.extend([
            line("", 1),
            line(&long, 1),
            line("c0", 0),
            line("c0", MAX_QUANTITY + 1),
            line("c1", MAX_QUANTITY),
        ]);
        let tidied = tidy(many);
        assert_eq!(tidied.len(), MAX_OFFER_LINES);
        assert_eq!(
            tidied[0],
            line("c0", 1),
            "out-of-range quantities are dropped"
        );
        assert_eq!(
            tidied[1],
            line("c1", MAX_QUANTITY),
            "a fold is held at the cap"
        );
    }

    #[test]
    fn the_wire_reads_as_the_page_writes_it() {
        let deal = TradeDeal {
            rev: 3,
            host: vec![line("bolt", 2)],
            guest: Vec::new(),
            host_accepted: true,
            guest_accepted: false,
        };
        assert_eq!(
            serde_json::to_value(LobbyTrade {
                trade_id: Some(7),
                deal,
                unknown: 1
            })
            .unwrap(),
            serde_json::json!({
                "tradeId": 7,
                "unknown": 1,
                "deal": {
                    "rev": 3,
                    "host": [{"cardId": "bolt", "finish": "nonfoil", "quantity": 2}],
                    "guest": [],
                    "hostAccepted": true,
                    "guestAccepted": false
                }
            })
        );
    }
}
