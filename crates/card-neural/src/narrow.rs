//! Deciding among a card's printings from what their set symbol and collector band score.
//!
//! The whole-card embedder cannot tell reprints of one card apart: the art is shared, only the
//! set symbol and the collector band differ. Two small networks read those crops, and this is
//! the rule that turns the three scores of each candidate printing into either one printing
//! or a short, ordered list of choices. It is pure — scores in, ids out — so every threshold it
//! uses lives in [`EvidenceThresholds`], in `neural.json`, where it was tuned.

use crate::gallery::Id;
use crate::meta::EvidenceThresholds;

/// One printing of the decided card, with the scores of its evidence. A printing the evidence
/// gallery holds no row for has no symbol or band score: it is **unknown**, not a poor match.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Candidate {
    pub printing: Id,
    /// The whole-card score of the look this printing is pictured by.
    pub whole: f32,
    pub symbol: Option<f32>,
    pub band: Option<f32>,
}

impl Candidate {
    /// The score the rule ranks by; `None` when either piece of evidence is missing.
    fn combined(&self, th: &EvidenceThresholds) -> Option<f32> {
        Some(self.whole + th.symbol_weight * self.symbol? + th.band_weight * self.band?)
    }
}

/// What the evidence settles.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Narrowed {
    /// The one printing, when the evidence is sure of it.
    pub decided: Option<Id>,
    /// The printings still in play, best first; when `decided` is set, that printing alone.
    pub choices: Vec<Id>,
}

/// Decides among `candidates`, or narrows them to the ones still worth offering.
///
/// `combined = whole + symbol_weight·symbol + band_weight·band`, for a candidate with both
/// scores. A candidate missing either is unknown. The best candidate is **decided** only when
/// no candidate is unknown and it is alone or leads the second by `decide_margin`. Otherwise
/// nothing is decided, and the choices are the known candidates within `keep_gap` of the best,
/// best first, then every unknown candidate in input order — an unknown one cannot be ruled out.
///
/// Ties keep the input order (the sort is stable), so the caller's ordering — the decided
/// look's printings first — breaks a tie between equal `combined` scores.
pub fn narrow(candidates: &[Candidate], th: &EvidenceThresholds) -> Narrowed {
    if let [only] = candidates {
        return Narrowed {
            decided: Some(only.printing),
            choices: vec![only.printing],
        };
    }
    let mut known: Vec<(Id, f32)> = candidates
        .iter()
        .filter_map(|c| Some((c.printing, c.combined(th)?)))
        .collect();
    known.sort_by(|a, b| b.1.total_cmp(&a.1));
    let any_unknown = known.len() < candidates.len();

    if let Some(&(best, top)) = known.first() {
        let lead = known.get(1).map_or(f32::INFINITY, |second| top - second.1);
        if !any_unknown && lead >= th.decide_margin {
            return Narrowed {
                decided: Some(best),
                choices: vec![best],
            };
        }
    }

    let floor = known.first().map(|&(_, top)| top - th.keep_gap);
    let kept = known
        .iter()
        .filter(|&&(_, s)| floor.is_some_and(|f| s >= f))
        .map(|&(p, _)| p);
    let unknown = candidates
        .iter()
        .filter(|c| c.combined(th).is_none())
        .map(|c| c.printing);
    Narrowed {
        decided: None,
        choices: kept.chain(unknown).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn th() -> EvidenceThresholds {
        EvidenceThresholds {
            candidate_gap: 0.08,
            symbol_weight: 1.0,
            band_weight: 1.0,
            decide_margin: 0.1,
            keep_gap: 0.15,
        }
    }

    fn id(n: u8) -> Id {
        [n; 16]
    }

    fn c(n: u8, whole: f32, symbol: Option<f32>, band: Option<f32>) -> Candidate {
        Candidate {
            printing: id(n),
            whole,
            symbol,
            band,
        }
    }

    #[test]
    fn one_candidate_is_decided() {
        let n = narrow(&[c(1, 0.7, None, None)], &th());
        assert_eq!(n.decided, Some(id(1)));
        assert_eq!(n.choices, vec![id(1)]);
    }

    #[test]
    fn no_candidates_decide_nothing() {
        let n = narrow(&[], &th());
        assert_eq!((n.decided, n.choices), (None, vec![]));
    }

    #[test]
    fn a_clear_lead_on_the_crops_decides() {
        let n = narrow(
            &[
                c(1, 0.70, Some(0.9), Some(0.8)),
                c(2, 0.71, Some(0.3), Some(0.2)),
            ],
            &th(),
        );
        assert_eq!(n.decided, Some(id(1)));
        assert_eq!(n.choices, vec![id(1)]);
    }

    #[test]
    fn the_best_leads_whichever_place_it_has_in_the_input() {
        let n = narrow(
            &[
                c(2, 0.71, Some(0.3), Some(0.2)),
                c(1, 0.70, Some(0.9), Some(0.8)),
            ],
            &th(),
        );
        assert_eq!(n.decided, Some(id(1)));
    }

    #[test]
    fn a_narrow_lead_stays_ambiguous_with_both_choices_best_first() {
        let n = narrow(
            &[
                c(2, 0.7, Some(0.58), Some(0.57)),
                c(1, 0.7, Some(0.6), Some(0.6)),
            ],
            &th(),
        );
        assert_eq!(n.decided, None);
        assert_eq!(n.choices, vec![id(1), id(2)]);
    }

    #[test]
    fn a_lead_of_exactly_the_margin_decides() {
        // 1.5 and 1.25 are exact in binary, so the difference is exactly 0.25.
        let th = EvidenceThresholds {
            decide_margin: 0.25,
            ..th()
        };
        let n = narrow(
            &[
                c(1, 0.5, Some(0.5), Some(0.5)),
                c(2, 0.5, Some(0.25), Some(0.5)),
            ],
            &th,
        );
        assert_eq!(n.decided, Some(id(1)));
    }

    #[test]
    fn candidates_far_behind_the_best_are_dropped_from_the_choices() {
        // Combined 2.0, 1.95 and 1.6: the third is 0.4 behind the best.
        let n = narrow(
            &[
                c(1, 0.8, Some(0.6), Some(0.6)),
                c(2, 0.8, Some(0.58), Some(0.57)),
                c(3, 0.8, Some(0.4), Some(0.4)),
            ],
            &th(),
        );
        assert_eq!(n.decided, None);
        assert_eq!(n.choices, vec![id(1), id(2)]);
    }

    #[test]
    fn a_candidate_with_no_evidence_row_is_kept_and_blocks_a_decision() {
        let n = narrow(
            &[c(1, 0.7, Some(0.9), Some(0.9)), c(2, 0.7, None, Some(0.1))],
            &th(),
        );
        assert_eq!(n.decided, None);
        assert_eq!(n.choices, vec![id(1), id(2)]);
    }

    #[test]
    fn unknown_candidates_follow_the_known_in_input_order() {
        let n = narrow(
            &[
                c(3, 0.7, None, None),
                c(1, 0.7, Some(0.5), Some(0.5)),
                c(4, 0.7, Some(0.5), None),
                c(2, 0.7, Some(0.5), Some(0.5)),
            ],
            &th(),
        );
        assert_eq!(n.decided, None);
        assert_eq!(n.choices, vec![id(1), id(2), id(3), id(4)]);
    }

    #[test]
    fn nothing_known_offers_every_candidate_as_given() {
        let n = narrow(&[c(2, 0.7, None, None), c(1, 0.9, None, None)], &th());
        assert_eq!(n.decided, None);
        assert_eq!(n.choices, vec![id(2), id(1)]);
    }

    #[test]
    fn equal_scores_keep_the_input_order() {
        let n = narrow(
            &[
                c(5, 0.7, Some(0.5), Some(0.5)),
                c(4, 0.7, Some(0.5), Some(0.5)),
            ],
            &th(),
        );
        assert_eq!(n.decided, None);
        assert_eq!(n.choices, vec![id(5), id(4)]);
    }
}
