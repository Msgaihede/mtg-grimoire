//! How a bot picks a card out of a pack — phase.rs's own draft bots, ported.
//!
//! **Ported from phase.rs's `crates/draft-wasm/src/bot_ai.rs`** (`bot_pick`, `bot_picks` and their
//! helpers, at the `rev` this crate pins; MIT OR Apache-2.0, credited with the engine in
//! `docs/reference/goldfish.md`). `draft-wasm` is a `cdylib`, which no crate can link, so its
//! pick-and-pass half lives here, kept as close to phase's as the types allow: the Winston half
//! is left out, as Winston drafts are not offered. Move it with the `rev` — a bot that picks
//! differently from phase's is a bug here, never a feature.
//!
//! The strategy scales with difficulty: `VeryEasy` picks at random, `Easy` the rarest card,
//! `Medium` and `Hard` score each card with `phase_ai::draft_eval` (its quality, a rarity prior,
//! its colours against the pool's and its place on the curve), and `VeryHard` does the same with
//! stricter colour discipline. With no `CardDatabase` the evaluation falls back to the lighter
//! colour, rarity and curve heuristic, as phase's does.
//!
//! The scoring reads parsed card faces, so it runs on `on_engine_stack` like every call into the
//! engine.

use draft_core::types::DraftCardInstance;
use engine::database::CardDatabase;
use phase_ai::config::AiDifficulty;
use phase_ai::draft_eval;
use rand::Rng;

use crate::Difficulty;

/// phase's difficulty for ours: the same five presets the playtest AI takes.
pub(super) fn level(difficulty: Difficulty) -> AiDifficulty {
    match difficulty {
        Difficulty::VeryEasy => AiDifficulty::VeryEasy,
        Difficulty::Easy => AiDifficulty::Easy,
        Difficulty::Medium => AiDifficulty::Medium,
        Difficulty::Hard => AiDifficulty::Hard,
        Difficulty::VeryHard => AiDifficulty::VeryHard,
    }
}

/// Whether bots at `difficulty` read card faces at all: only the evaluating presets do, so the
/// others never parse the draft's cards.
pub(super) fn reads_faces(difficulty: Difficulty) -> bool {
    matches!(
        difficulty,
        Difficulty::Medium | Difficulty::Hard | Difficulty::VeryHard
    )
}

/// The index into `pack` a bot picks, given what it has picked before (`prior_picks`).
pub(super) fn bot_pick(
    pack: &[DraftCardInstance],
    difficulty: AiDifficulty,
    prior_picks: &[DraftCardInstance],
    card_db: Option<&CardDatabase>,
    rng: &mut impl Rng,
) -> usize {
    if pack.is_empty() {
        return 0;
    }

    match difficulty {
        AiDifficulty::VeryEasy => rng.random_range(0..pack.len()),
        AiDifficulty::Easy => pick_by_rarity(pack),
        AiDifficulty::Medium | AiDifficulty::Hard => {
            pick_by_evaluation(pack, prior_picks, card_db, false)
        }
        AiDifficulty::VeryHard | AiDifficulty::CEDH => {
            pick_by_evaluation(pack, prior_picks, card_db, true)
        }
    }
}

/// `count` distinct indices into `pack` for one pick step (every index when the pack holds
/// fewer), in the order chosen: `bot_pick` applied to the shrinking remainder.
pub(super) fn bot_picks(
    pack: &[DraftCardInstance],
    count: usize,
    difficulty: AiDifficulty,
    prior_picks: &[DraftCardInstance],
    card_db: Option<&CardDatabase>,
    rng: &mut impl Rng,
) -> Vec<usize> {
    let mut candidates: Vec<DraftCardInstance> = pack.to_vec();
    let mut original_indices: Vec<usize> = (0..pack.len()).collect();
    let mut picked = Vec::with_capacity(count.min(candidates.len()));

    for _ in 0..count.min(pack.len()) {
        let position = bot_pick(&candidates, difficulty, prior_picks, card_db, rng);
        candidates.swap_remove(position);
        picked.push(original_indices.swap_remove(position));
    }

    picked
}

/// The highest-rarity card; a tie goes to the first.
fn pick_by_rarity(pack: &[DraftCardInstance]) -> usize {
    pack.iter()
        .enumerate()
        .max_by_key(|(_, c)| rarity_score(&c.rarity))
        .map(|(i, _)| i)
        .unwrap_or(0)
}

/// The lighter heuristic, with no card database: rarity × 2, plus colour, plus curve.
fn pick_by_color_and_rarity(
    pack: &[DraftCardInstance],
    prior_picks: &[DraftCardInstance],
) -> usize {
    let preferred_colors = color_preference(prior_picks);

    pack.iter()
        .enumerate()
        .max_by_key(|(_, card)| {
            let rarity = rarity_score(&card.rarity) as i16 * 2;
            let color_bonus = if card.colors.is_empty() {
                1i16
            } else if card.colors.iter().any(|c| preferred_colors.contains(c)) {
                3
            } else if preferred_colors.is_empty() {
                0
            } else {
                -1
            };
            let curve = curve_bonus(card.cmc, prior_picks.len() as u8);
            rarity + color_bonus + curve as i16
        })
        .map(|(i, _)| i)
        .unwrap_or(0)
}

/// `Medium` to `VeryHard`: `draft_eval`'s quality, a rarity prior, colour discipline and the
/// curve. `strict` (`VeryHard`) raises the on-colour bonus and penalises off-colour cards.
fn pick_by_evaluation(
    pack: &[DraftCardInstance],
    prior_picks: &[DraftCardInstance],
    card_db: Option<&CardDatabase>,
    strict: bool,
) -> usize {
    let card_db = match card_db {
        Some(db) => db,
        None => return pick_by_color_and_rarity(pack, prior_picks),
    };

    let preferred_colors = color_preference(prior_picks);
    let pick_number = prior_picks.len() as u8;
    let on_color_bonus: f64 = if strict { 6.0 } else { 4.0 };
    let off_color_penalty: f64 = if strict { -2.0 } else { 0.0 };
    let score = |card: &DraftCardInstance| {
        eval_score(
            card,
            card_db,
            &preferred_colors,
            pick_number,
            on_color_bonus,
            off_color_penalty,
        )
    };

    pack.iter()
        .enumerate()
        .max_by(|(_, a), (_, b)| {
            score(a)
                .partial_cmp(&score(b))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|(i, _)| i)
        .unwrap_or(0)
}

/// A card's score in this pick's context.
fn eval_score(
    card: &DraftCardInstance,
    card_db: &CardDatabase,
    preferred_colors: &[String],
    pick_number: u8,
    on_color_bonus: f64,
    off_color_penalty: f64,
) -> f64 {
    let base = card_quality(card, Some(card_db));
    let color_bonus = if card.colors.is_empty() {
        1.0
    } else if preferred_colors.is_empty() {
        0.0
    } else if card.colors.iter().any(|c| preferred_colors.contains(c)) {
        on_color_bonus
    } else {
        off_color_penalty
    };
    base + color_bonus + curve_bonus(card.cmc, pick_number) as f64
}

/// The card's own quality — `draft_eval` on its face — plus a small rarity prior. The face is
/// looked up by its front face's name (`A // B` is known by `A`), as `cards::engine_name` does.
fn card_quality(card: &DraftCardInstance, card_db: Option<&CardDatabase>) -> f64 {
    let front = card.name.split(" // ").next().unwrap_or(&card.name);
    let quality = card_db
        .and_then(|db| db.get_face_by_name(front))
        .map(draft_eval::evaluate_draft_card_default)
        .unwrap_or(0.0);
    quality + draft_eval::rarity_prior(&card.rarity)
}

fn rarity_score(rarity: &str) -> u8 {
    match rarity {
        "mythic" => 4,
        "rare" => 3,
        "uncommon" => 2,
        "common" => 1,
        _ => 0,
    }
}

/// The pool's one or two main colours, or none before three picks (`draft_eval::dominant_colors`,
/// whose total order makes a tie the same answer every time).
fn color_preference(prior_picks: &[DraftCardInstance]) -> Vec<String> {
    let colors: Vec<&[String]> = prior_picks
        .iter()
        .map(|card| card.colors.as_slice())
        .collect();
    draft_eval::dominant_colors(&colors, 3)
}

/// The curve: two- to four-drops, more so early in the draft.
fn curve_bonus(cmc: u8, pick_number: u8) -> i8 {
    let early = pick_number < 15;
    match cmc {
        2 | 3 => {
            if early {
                2
            } else {
                1
            }
        }
        4 => 1,
        0 | 1 | 5 => 0,
        _ => {
            if early {
                -1
            } else {
                0
            }
        }
    }
}
