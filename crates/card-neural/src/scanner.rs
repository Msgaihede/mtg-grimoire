//! One frame, start to finish: find the cards, straighten each, fingerprint, search, rank.
//!
//! The order of quickdraw.cards' `NeuralScanner.recognize`, without its two speed-ups for a held
//! card (tracking the last quad at 0.6× the input, and carrying a sure fingerprint over up to
//! three unchanged frames): both trade work for latency and change no answer on a frame they
//! skip. Nothing is remembered between frames here; [`crate::session::Agreement`] is what
//! agrees across them.

use crate::detect::{Detection, Detector};
use crate::embed::Embedder;
use crate::frame::{area, centre, contains, rotate_half, sample_card, Frame, Point, Quad};
use crate::gallery::{Admit, Gallery};
use crate::meta::{Meta, Ranking, Thresholds};
use crate::{Error, Files};

/// Looks of one card within this score of the best are the same picture (identical-art
/// reprints in different looks): the picture alone cannot say which.
pub const TWIN_GAP: f32 = 0.04;

/// One searched view's verdict, before ranking.
#[derive(Clone, Debug, PartialEq)]
pub struct Scored {
    pub entry: u32,
    pub card: u32,
    pub score: f32,
    /// Lead over the best look of another card (the whole score when no other card is in the
    /// top k).
    pub margin: f32,
    /// Looks of the same card within [`TWIN_GAP`] of the best, the best first.
    pub twins: Vec<u32>,
}

/// Score a search result: the best look, its lead over the best other card, and its twins.
pub fn score_top(top: &[(u32, f32)], gallery: &Gallery) -> Option<Scored> {
    let &(entry, score) = top.first()?;
    let card = gallery.card(entry);
    let runner = top
        .iter()
        .skip(1)
        .find(|(e, _)| gallery.card(*e) != card)
        .map_or(0.0, |t| t.1);
    let mut twins = vec![entry];
    for &(e, s) in top.iter().skip(1) {
        if score - s > TWIN_GAP {
            break;
        }
        if gallery.card(e) == card && !twins.contains(&e) {
            twins.push(e);
        }
    }
    Some(Scored {
        entry,
        card,
        score,
        margin: score - runner,
        twins,
    })
}

/// A card in the frame, fingerprinted and judged.
#[derive(Clone, Debug)]
pub struct Found {
    pub detection: Detection,
    /// The quad the winning view was read through (the detection's, or it turned half a turn).
    pub quad: Quad,
    pub flipped: bool,
    pub scored: Scored,
    /// The search's best looks for this card, best first, with their cosine scores.
    pub top: Vec<(u32, f32)>,
    pub accepted: bool,
    /// Size over distance from the target point; doubled when accepted. The ranking key.
    pub prominence: f32,
    /// The target point is inside the card's quad: the card the reader aimed at. Ranks first
    /// under [`Ranking::Aimed`].
    pub aimed: bool,
}

/// What one frame says.
#[derive(Clone, Debug, Default)]
pub struct Read {
    /// Every fingerprinted card, the one the frame votes for first.
    pub cards: Vec<Found>,
    /// The first card clears the accept bar.
    pub accepted: bool,
    /// Just under it on a confident detection: counts toward a three-frame agreement.
    pub supported: bool,
    /// Accepted and sure enough to decide on this frame alone.
    pub instant: bool,
    /// Under accept but close: may keep earlier evidence alive rather than reset it.
    pub weak: bool,
    /// Some detection cleared `detAccept`: a card is in front of the lens, whether or not it
    /// was recognised. What [`crate::session::Agreement`] counts a card's absence by.
    pub present: bool,
    /// Detector passes this frame took (one, plus one per refined card).
    pub detector_runs: usize,
    /// Views embedded: one per card, two for a card of unsure orientation.
    pub crops: usize,
}

impl Read {
    pub fn best(&self) -> Option<&Found> {
        self.cards.first()
    }
}

/// Rank fingerprinted cards and judge the frame. Every card's `accepted`, `prominence` and
/// `aimed` are worked out here from `th`, not carried in, so cards fingerprinted once can be
/// ranked again under other thresholds without running a model. `frame_size` is the frame's
/// width and height in pixels; `target` is the point nearness is measured from, as a fraction
/// of the frame.
pub fn rank(
    mut cards: Vec<Found>,
    th: &Thresholds,
    ranking: Ranking,
    (w, h): (f32, f32),
    target: (f32, f32),
) -> Read {
    let aim = Point {
        x: target.0 * w,
        y: target.1 * h,
    };
    for c in &mut cards {
        c.accepted = c.scored.score >= th.accept
            && c.scored.margin >= th.margin
            && c.detection.score >= th.det_accept;
        c.aimed = contains(&c.quad, aim);
        let m = centre(&c.quad);
        let dist = (m.x / w - target.0).hypot(m.y / h - target.1);
        let bonus = if c.accepted { 2.0 } else { 1.0 };
        c.prominence = (area(&c.quad).abs() / (w * h)).sqrt() / (0.25 + dist) * bonus;
    }
    let aimed_first = ranking == Ranking::Aimed;
    cards.sort_by(|a, b| {
        (aimed_first && b.aimed)
            .cmp(&(aimed_first && a.aimed))
            .then(b.prominence.total_cmp(&a.prominence))
    });
    judge(cards, th)
}

/// Judge the first of the ranked cards against the thresholds.
pub fn judge(cards: Vec<Found>, th: &Thresholds) -> Read {
    let (mut accepted, mut supported, mut instant, mut weak) = (false, false, false, false);
    if let Some(b) = cards.first() {
        let (s, m, d) = (b.scored.score, b.scored.margin, b.detection.score);
        accepted = b.accepted;
        weak = !accepted && s >= th.weak && m >= th.weak_margin;
        supported = !accepted && s >= th.support && m >= th.support_margin && d >= th.det_support;
        instant = accepted && s >= th.instant && m >= th.instant_margin && d >= th.det_instant;
    }
    let present = cards.iter().any(|c| c.detection.score >= th.det_accept);
    Read {
        cards,
        accepted,
        supported,
        instant,
        weak,
        present,
        ..Default::default()
    }
}

pub struct Recognizer {
    detector: Detector,
    embedder: Embedder,
    meta: Meta,
    gallery: Gallery,
    crops: Vec<f32>,
    /// The point a card nearest to wins a tie of size, as a fraction of the frame.
    pub target: (f32, f32),
}

impl Recognizer {
    /// Build the recogniser. The gallery is read where it lies — borrowed from a compiled-in
    /// file, or moved from an owned one — and the networks are parsed into `rten`'s own form.
    pub fn load(files: Files<'static>) -> Result<Recognizer, Error> {
        let meta = Meta::from_json(&files.meta)?;
        let gallery = Gallery::from_bytes(files.gallery)?;
        if gallery.dim() != meta.embedder.dim {
            return Err(Error::Gallery(format!(
                "a {}-d gallery for a {}-d embedder",
                gallery.dim(),
                meta.embedder.dim
            )));
        }
        let detector = Detector::load(
            files.detector.into_owned(),
            meta.detector.clone(),
            meta.thresholds.det_logit,
        )?;
        let embedder = Embedder::load(files.embedder.into_owned(), meta.embedder.clone())?;
        Ok(Recognizer {
            detector,
            embedder,
            meta,
            gallery,
            crops: Vec::new(),
            target: (0.5, 0.5),
        })
    }

    pub fn meta(&self) -> &Meta {
        &self.meta
    }

    pub fn gallery(&self) -> &Gallery {
        &self.gallery
    }

    /// Judge by other thresholds, the detector's candidate floor included.
    pub fn set_thresholds(&mut self, th: Thresholds) {
        self.detector.set_det_logit(th.det_logit);
        self.meta.thresholds = th;
    }

    /// One frame: every card found, fingerprinted, searched among the looks `admit` lets
    /// through (all of them when `None`), ranked and judged.
    pub fn read(&mut self, frame: &Frame, admit: Option<&Admit>) -> Result<Read, Error> {
        let dets = self
            .detector
            .detect(frame, self.meta.refine, self.meta.max_cards)?;
        let detector_runs = self.detector.take_runs();
        let (cards, crops) = self.fingerprint(frame, &dets, admit)?;
        let size = (frame.width as f32, frame.height as f32);
        let mut read = rank(
            cards,
            &self.meta.thresholds,
            self.meta.ranking,
            size,
            self.target,
        );
        read.detector_runs = detector_runs;
        read.crops = crops;
        Ok(read)
    }

    /// The model half of [`Recognizer::read`] after the detector: each detected card's best
    /// view, searched, in detection order and not yet ranked (`accepted` and `aimed` false,
    /// `prominence` 0 until [`rank`]), and how many views were embedded.
    pub fn fingerprint(
        &mut self,
        frame: &Frame,
        dets: &[Detection],
        admit: Option<&Admit>,
    ) -> Result<(Vec<Found>, usize), Error> {
        // Orientation is predicted; an unsure card is searched both ways up.
        let (ew, eh, crop) = (
            self.meta.embedder.width,
            self.meta.embedder.height,
            self.meta.embedder.crop,
        );
        let slot = 3 * ew * eh;
        let max_batch = self.meta.embedder.max_batch;
        let mut jobs: Vec<(usize, Quad)> = Vec::new();
        self.crops.resize(max_batch * slot, 0.0);
        'dets: for (i, det) in dets.iter().enumerate() {
            let views = if (det.flip - 0.5).abs() > self.meta.thresholds.flip_sure {
                vec![det.quad]
            } else {
                vec![det.quad, rotate_half(&det.quad)]
            };
            for quad in views {
                if jobs.len() >= max_batch {
                    break 'dets;
                }
                let at = jobs.len() * slot;
                if sample_card(
                    frame,
                    &quad,
                    crop,
                    ew,
                    eh,
                    &mut self.crops[at..at + slot],
                    None,
                ) {
                    jobs.push((i, quad));
                }
            }
        }
        let crops = jobs.len();
        if jobs.is_empty() {
            return Ok((Vec::new(), 0));
        }
        let dim = self.meta.embedder.dim;
        let embeddings = self
            .embedder
            .run(&self.crops[..jobs.len() * slot], jobs.len())?;
        // The best view per detected card.
        let mut per_card: Vec<Option<Found>> = vec![None; dets.len()];
        for (j, (det_index, quad)) in jobs.into_iter().enumerate() {
            let top = self.gallery.top(
                &embeddings[j * dim..(j + 1) * dim],
                self.meta.embedder.topk,
                admit,
            )?;
            let Some(scored) = score_top(&top, &self.gallery) else {
                continue;
            };
            let det = &dets[det_index];
            if per_card[det_index]
                .as_ref()
                .is_some_and(|f| f.scored.score >= scored.score)
            {
                continue;
            }
            per_card[det_index] = Some(Found {
                detection: det.clone(),
                flipped: quad != det.quad,
                quad,
                scored,
                top,
                accepted: false,
                prominence: 0.0,
                aimed: false,
            });
        }
        Ok((per_card.into_iter().flatten().collect(), crops))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gallery::{Face, Look};

    /// One look a card, `cards[i]` its card group.
    fn gallery(cards: &[u32]) -> Gallery {
        let looks: Vec<Look> = cards
            .iter()
            .enumerate()
            .map(|(i, &card)| Look {
                printing: [i as u8; 16],
                card,
                face: Face::Front,
                covers: vec![[i as u8; 16]],
                name: format!("card {card}"),
            })
            .collect();
        let mut rows = vec![0.0; cards.len() * 2];
        for (i, r) in rows.as_chunks_mut::<2>().0.iter_mut().enumerate() {
            r[i % 2] = 1.0;
        }
        Gallery::build(&rows, 2, &looks).unwrap()
    }

    #[test]
    fn the_margin_is_measured_against_another_card_not_another_look_of_this_one() {
        // Entries 0 and 1 are one card; 2 is another.
        let g = gallery(&[7, 7, 9]);
        let s = score_top(&[(0, 0.80), (1, 0.78), (2, 0.50)], &g).unwrap();
        assert_eq!(s.card, 7);
        assert!((s.margin - 0.30).abs() < 1e-6);
        assert_eq!(s.twins, vec![0, 1], "a look within the twin gap is a twin");
    }

    #[test]
    fn a_look_further_than_the_twin_gap_is_not_a_twin() {
        let g = gallery(&[7, 7, 9]);
        let s = score_top(&[(0, 0.80), (1, 0.70), (2, 0.50)], &g).unwrap();
        assert_eq!(s.twins, vec![0]);
    }

    #[test]
    fn no_other_card_in_the_top_k_leaves_the_whole_score_as_margin() {
        let g = gallery(&[7, 7]);
        let s = score_top(&[(1, 0.65), (0, 0.40)], &g).unwrap();
        assert!((s.margin - 0.65).abs() < 1e-6);
        assert!(score_top(&[], &g).is_none());
    }

    pub(crate) fn th() -> Thresholds {
        Thresholds {
            det_logit: -1.0,
            det_accept: 0.5,
            det_instant: 0.6,
            accept: 0.6,
            margin: 0.12,
            instant: 0.7,
            instant_margin: 0.18,
            weak: 0.5,
            weak_margin: 0.05,
            support: 0.48,
            support_margin: 0.08,
            det_support: 0.8,
            flip_sure: 0.4,
        }
    }

    fn found(score: f32, margin: f32, det: f32, th: &Thresholds) -> Found {
        Found {
            detection: Detection {
                score: det,
                quad: Default::default(),
                flip: 0.0,
            },
            quad: Default::default(),
            flipped: false,
            scored: Scored {
                entry: 0,
                card: 0,
                score,
                margin,
                twins: vec![0],
            },
            top: vec![(0, score)],
            accepted: score >= th.accept && margin >= th.margin && det >= th.det_accept,
            prominence: 1.0,
            aimed: false,
        }
    }

    #[test]
    fn the_four_frame_verdicts_follow_the_thresholds() {
        let t = th();
        let r = judge(vec![found(0.83, 0.44, 0.93, &t)], &t);
        assert!(r.accepted && r.instant && !r.supported && !r.weak && r.present);
        let r = judge(vec![found(0.65, 0.13, 0.55, &t)], &t);
        assert!(
            r.accepted && !r.instant,
            "accepted, but the detection is not sure enough to decide alone"
        );
        let r = judge(vec![found(0.55, 0.10, 0.90, &t)], &t);
        assert!(!r.accepted && r.supported && r.weak);
        let r = judge(vec![found(0.40, 0.30, 0.90, &t)], &t);
        assert!(!r.accepted && !r.supported && !r.weak && r.present);
        let r = judge(vec![found(0.90, 0.40, 0.30, &t)], &t);
        assert!(
            !r.present,
            "a detection under detAccept is no card in front of the lens"
        );
        let r = judge(vec![], &t);
        assert!(!r.accepted && r.best().is_none() && !r.present);
    }

    /// An unranked card: a `side`-pixel square centred at `x` across the 100×100 frame, as
    /// [`Recognizer::fingerprint`] leaves it (not accepted, no prominence).
    fn unranked_at(card: u32, x: f32, side: f32, score: f32, margin: f32) -> Found {
        let (l, r) = (x - side / 2.0, x + side / 2.0);
        let (t, b) = (50.0 - side / 2.0, 50.0 + side / 2.0);
        let quad = [
            Point { x: l, y: t },
            Point { x: r, y: t },
            Point { x: r, y: b },
            Point { x: l, y: b },
        ];
        Found {
            detection: Detection {
                score: 0.9,
                quad,
                flip: 0.0,
            },
            quad,
            flipped: false,
            scored: Scored {
                entry: card,
                card,
                score,
                margin,
                twins: vec![card],
            },
            top: vec![(card, score)],
            accepted: false,
            prominence: 0.0,
            aimed: false,
        }
    }

    fn ranked(ranking: Ranking, cards: Vec<Found>, th: &Thresholds) -> Read {
        rank(cards, th, ranking, (100.0, 100.0), (0.5, 0.5))
    }

    #[test]
    fn ranking_again_under_stricter_thresholds_unaccepts_and_reorders() {
        // The big card is barely accepted; the small one is sure. Both accepted, size wins.
        let cards = vec![
            unranked_at(2, 50.0, 40.0, 0.90, 0.40),
            unranked_at(1, 50.0, 60.0, 0.65, 0.13),
        ];
        let r = ranked(Ranking::Quickdraw, cards.clone(), &th());
        assert_eq!(r.best().map(|b| b.scored.card), Some(1));
        assert!(r.cards.iter().all(|c| c.accepted) && r.accepted);
        assert!((r.cards[0].prominence - 2.0 * 0.6 / 0.25).abs() < 1e-4);

        // Raise the bar: the big card loses its acceptance, its doubled prominence with it,
        // and the small sure card ranks first.
        let strict = Thresholds {
            accept: 0.7,
            ..th()
        };
        let r = ranked(Ranking::Quickdraw, cards, &strict);
        assert_eq!(r.best().map(|b| b.scored.card), Some(2));
        assert!(r.accepted, "the card now first is still accepted");
        let big = r.cards.iter().find(|c| c.scored.card == 1).unwrap();
        assert!(!big.accepted);
        assert!((big.prominence - 0.6 / 0.25).abs() < 1e-4);
    }

    /// A binder page, as the spike's two wrong calls lay: the reader's card just right of the
    /// middle, read just under the accept bar, and a recognised neighbour cut off at the left.
    fn binder_page() -> Vec<Found> {
        vec![
            unranked_at(1, 17.0, 50.0, 0.82, 0.33),
            unranked_at(2, 62.0, 50.0, 0.59, 0.10),
        ]
    }

    #[test]
    fn a_recognised_neighbour_outranks_the_card_in_the_middle_only_by_quickdraws_rule() {
        let r = ranked(Ranking::Quickdraw, binder_page(), &th());
        assert_eq!(
            r.best().map(|b| b.scored.card),
            Some(1),
            "doubled for accepted"
        );
        assert!(r.accepted, "so the frame votes for the neighbour");

        let r = ranked(Ranking::Aimed, binder_page(), &th());
        assert_eq!(r.best().map(|b| b.scored.card), Some(2));
        assert!(!r.accepted && r.supported, "it votes only as support");
        assert_eq!(
            r.cards.iter().map(|c| c.aimed).collect::<Vec<_>>(),
            [true, false]
        );
    }

    #[test]
    fn with_no_card_under_the_target_aimed_ranks_as_quickdraw_does() {
        let apart = vec![
            unranked_at(1, 15.0, 30.0, 0.82, 0.33),
            unranked_at(2, 75.0, 30.0, 0.59, 0.07),
        ];
        let r = ranked(Ranking::Aimed, apart, &th());
        assert!(r.cards.iter().all(|c| !c.aimed));
        assert_eq!(r.best().map(|b| b.scored.card), Some(1));
    }
}
