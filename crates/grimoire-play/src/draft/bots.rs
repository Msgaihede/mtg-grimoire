//! How a bot picks a card out of a pack, and how it takes or declines a Winston pile — phase.rs's
//! own draft bots, ported.
//!
//! **Ported from phase.rs's `crates/draft-wasm/src/bot_ai.rs`** (`bot_pick`, `bot_picks`,
//! `winston_decision`, `opponent_read` and their helpers, at the `rev` this crate pins; MIT OR
//! Apache-2.0, credited with the engine in `docs/reference/goldfish.md`). `draft-wasm` is a
//! `cdylib`, which no crate can link, so both halves live here, kept as close to phase's as the
//! types allow. Move them with the `rev` — a bot that picks differently from phase's is a bug
//! here, never a feature.
//!
//! The strategy scales with difficulty: `VeryEasy` picks at random, `Easy` the rarest card,
//! `Medium` and `Hard` score each card with `phase_ai::draft_eval` (its quality, a rarity prior,
//! its colours against the pool's and its place on the curve), and `VeryHard` does the same with
//! stricter colour discipline. With no `CardDatabase` the evaluation falls back to the lighter
//! colour, rarity and curve heuristic, as phase's does.
//!
//! **The Winston bot** (`winston_decision`) decides take-or-decline at the cursor of a shared-stack
//! turn from the seat's own projection (`draft_core::view::filter_for_player`) and nothing else,
//! scoring with `phase_ai::winston_eval`; it picks among the decisions the engine *published* as
//! legal, and rolls no dice — the same projection is the same decision.
//!
//! The scoring reads parsed card faces, so it runs on `on_engine_stack` like every call into the
//! engine.

use draft_core::types::{DraftCardInstance, SharedStackPileDecision};
use draft_core::view::{DraftPlayerView, SharedStackPileView, SharedStackView};
use engine::database::CardDatabase;
use phase_ai::config::AiDifficulty;
use phase_ai::draft_eval;
use phase_ai::winston_eval::{
    draft_progress, valuate_turn, CardContext, ColorPassTally, DraftCardFacts, OpponentRead,
    WinstonStrategy, WinstonTurn,
};
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

// ── Shared-stack (Winston) bot ──────────────────────────────────────────────────────────────────

/// Cards a Winston bot must hold before its own pool implies a colour preference at all — the
/// pick-and-pass bot's floor (`color_preference`).
const MIN_POOL_COLOR_SAMPLE: usize = 3;

/// One published card, as the valuation layer wants it. The face is looked up by its front face's
/// name, as `card_quality` looks it up (this crate's database knows `A // B` by `A`).
fn card_facts<'a>(
    card: &'a DraftCardInstance,
    card_db: Option<&'a CardDatabase>,
) -> DraftCardFacts<'a> {
    let front = card.name.split(" // ").next().unwrap_or(&card.name);
    DraftCardFacts {
        face: card_db.and_then(|db| db.get_face_by_name(front)),
        rarity: &card.rarity,
        cmc: card.cmc,
        colors: &card.colors,
    }
}

/// Whether the engine published `decision` as legal on `pile`. A decision the vector does not
/// mention is illegal — the safe direction.
fn published_legal(pile: &SharedStackPileView, decision: SharedStackPileDecision) -> bool {
    pile.legality
        .iter()
        .any(|entry| entry.decision == decision && entry.refusal.is_none())
}

/// Laplace-smoothed share, `(hits + 1) / (trials + 2)`.
fn laplace_rate(hits: usize, trials: usize) -> f64 {
    (hits + 1) as f64 / (trials + 2) as f64
}

/// What the other seats have told the bot about themselves, folded out of the published decision
/// history and the bot's own published `revealed` prefixes: their appetite for small and large
/// piles, and the colours they passed on piles not taken since (phase's reconstruction rule —
/// a later take on a pile destroys its prefix; a prefix is read by the pile's `index` and
/// truncated to what is published).
fn opponent_read(stack: &SharedStackView, own_seat: u8, split: usize) -> OpponentRead {
    let mut small_takes = 0usize;
    let mut small_total = 0usize;
    let mut large_takes = 0usize;
    let mut large_total = 0usize;
    let mut samples = 0usize;
    let mut passed_colors = ColorPassTally::default();

    for (index, record) in stack.history.iter().enumerate() {
        if record.seat == own_seat {
            continue;
        }
        samples += 1;

        let took = matches!(record.decision, SharedStackPileDecision::Take);
        if record.pile_size >= split {
            large_total += 1;
            large_takes += usize::from(took);
        } else {
            small_total += 1;
            small_takes += usize::from(took);
        }

        if took {
            continue;
        }
        let disturbed = stack.history[index + 1..].iter().any(|later| {
            later.pile == record.pile && matches!(later.decision, SharedStackPileDecision::Take)
        });
        if disturbed {
            continue;
        }
        let Some(pile) = stack.piles.iter().find(|pile| pile.index == record.pile) else {
            continue;
        };
        let seen = record.pile_size.min(pile.revealed.len());
        for card in &pile.revealed[..seen] {
            passed_colors.observe(&card.colors);
        }
    }

    OpponentRead {
        small_pile_take_rate: laplace_rate(small_takes, small_total),
        large_pile_take_rate: laplace_rate(large_takes, large_total),
        passed_colors,
        samples,
    }
}

/// A shared-stack turn decided: `(pile, take)` for the cursor pile, or `None` when the projection
/// has no live pile turn or the engine published no legal decision. `view` is the deciding seat's
/// own projection (`filter_for_player(session, active_seat)`); `VeryEasy` takes the first legal
/// decision, as phase's pick timer does, and the others score with `phase_ai::winston_eval`.
pub(super) fn winston_decision(
    view: &DraftPlayerView,
    difficulty: AiDifficulty,
    card_db: Option<&CardDatabase>,
) -> Option<(u8, SharedStackPileDecision)> {
    let stack = view.shared_stack.as_ref()?;
    let cursor = stack
        .piles
        .iter()
        .find(|pile| pile.index == stack.active_pile)?;

    let weights = match WinstonStrategy::for_difficulty(difficulty) {
        WinstonStrategy::FirstLegal => {
            return SharedStackPileDecision::ALL
                .into_iter()
                .find(|decision| published_legal(cursor, *decision))
                .map(|decision| (cursor.index, decision));
        }
        WinstonStrategy::Scored(weights) => weights,
    };

    let own_seat = stack.active_seat;
    let read = opponent_read(stack, own_seat, weights.opponent_size_split);

    let cursor_pile: Vec<DraftCardFacts> = cursor
        .revealed
        .iter()
        .map(|card| card_facts(card, card_db))
        .collect();
    let pool: Vec<DraftCardFacts> = view
        .pool
        .iter()
        .map(|card| card_facts(card, card_db))
        .collect();

    let pool_colors: Vec<&[String]> = view
        .pool
        .iter()
        .map(|card| card.colors.as_slice())
        .collect();
    let preferred_colors = draft_eval::dominant_colors(&pool_colors, MIN_POOL_COLOR_SAMPLE);

    // Heights only, in pile order, the last pile included.
    let mut later: Vec<&SharedStackPileView> = stack
        .piles
        .iter()
        .filter(|pile| pile.index > cursor.index)
        .collect();
    later.sort_by_key(|pile| pile.index);
    let later_pile_sizes: Vec<usize> = later.iter().map(|pile| pile.total).collect();

    // Priced only when the cursor is the final pile and the engine published that decline.
    let forced_draw_legal =
        later_pile_sizes.is_empty() && published_legal(cursor, SharedStackPileDecision::Decline);

    let turn = WinstonTurn {
        cursor_pile: &cursor_pile,
        later_pile_sizes: &later_pile_sizes,
        forced_draw_legal,
        pool: &pool,
        read: &read,
        context: CardContext {
            preferred_colors: &preferred_colors,
            progress: draft_progress(view.pool.len(), stack.total_cards, view.seats.len()),
            passed: &read.passed_colors,
        },
    };

    // Preference first, published legality second.
    let preferred = if valuate_turn(&turn, &weights).prefers_taking() {
        [
            SharedStackPileDecision::Take,
            SharedStackPileDecision::Decline,
        ]
    } else {
        [
            SharedStackPileDecision::Decline,
            SharedStackPileDecision::Take,
        ]
    };
    preferred
        .into_iter()
        .find(|decision| published_legal(cursor, *decision))
        .map(|decision| (cursor.index, decision))
}
