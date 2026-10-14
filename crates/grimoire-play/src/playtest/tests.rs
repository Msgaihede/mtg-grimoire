//! Playtest games end to end — a green deck against a red one played by phase's AI — every test
//! on the engine's stack. The AI plays at `VeryEasy` unless a test says otherwise: its other
//! presets search with a 1.5 s budget a decision, and these tests are about the session.

use crate::cards::CardFacts;
use crate::on_engine_stack;
use crate::view::{GameCard, Lane, Place, Seat};

use super::session::Playtest;
use super::view::{
    Difficulty, PlaytestAction as A, PlaytestAttackPair, PlaytestBlockPair, PlaytestHappened as H,
    PlaytestPhase, PlaytestPickPurpose, PlaytestStage as Stage, PlaytestStep, PlaytestStop,
    PlaytestStopStep, PlaytestView,
};

fn card(
    name: &str,
    cost: Option<&str>,
    type_line: &str,
    text: &str,
    pt: Option<(&str, &str)>,
    color: &str,
    quantity: u32,
) -> CardFacts {
    CardFacts {
        card_id: format!("print-{}", name.to_lowercase().replace([' ', ','], "-")),
        name: name.into(),
        quantity,
        mana_cost: cost.map(Into::into),
        type_line: Some(type_line.into()),
        oracle_text: Some(text.into()),
        power: pt.map(|p| p.0.into()),
        toughness: pt.map(|p| p.1.into()),
        cmc: Some(cost.map_or(0.0, |c| c.matches('{').count() as f64)),
        layout: Some("normal".into()),
        colors: if cost.is_some() {
            vec![color.into()]
        } else {
            vec![]
        },
        color_identity: vec![color.into()],
        ..CardFacts::default()
    }
}

/// The reader's: lands, two creatures and a pump spell.
fn green() -> Vec<CardFacts> {
    vec![
        card(
            "Forest",
            None,
            "Basic Land — Forest",
            "({T}: Add {G}.)",
            None,
            "G",
            17,
        ),
        card(
            "Grizzly Bears",
            Some("{1}{G}"),
            "Creature — Bear",
            "",
            Some(("2", "2")),
            "G",
            12,
        ),
        card(
            "Llanowar Elves",
            Some("{G}"),
            "Creature — Elf Druid",
            "{T}: Add {G}.",
            Some(("1", "1")),
            "G",
            8,
        ),
        card(
            "Giant Growth",
            Some("{G}"),
            "Instant",
            "Target creature gets +3/+3 until end of turn.",
            None,
            "G",
            3,
        ),
    ]
}

/// The AI's, and the reader's burn when a test needs a spell with a choice of target.
fn red() -> Vec<CardFacts> {
    vec![
        card(
            "Mountain",
            None,
            "Basic Land — Mountain",
            "({T}: Add {R}.)",
            None,
            "R",
            17,
        ),
        card(
            "Raging Goblin",
            Some("{R}"),
            "Creature — Goblin Berserker",
            "Haste",
            Some(("1", "1")),
            "R",
            12,
        ),
        card(
            "Hill Giant",
            Some("{3}{R}"),
            "Creature — Giant",
            "",
            Some(("3", "3")),
            "R",
            6,
        ),
        card(
            "Lightning Bolt",
            Some("{R}"),
            "Instant",
            "Lightning Bolt deals 3 damage to any target.",
            None,
            "R",
            5,
        ),
    ]
}

/// The AI's seat, for `put_for_test`.
const AI_SEAT: Seat = Seat::Opponent;

fn engine<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> T {
    on_engine_stack(work).expect("the engine ran")
}

/// A game. An even seed puts the reader on the play.
fn deal(you: Vec<CardFacts>, seed: u64) -> (Playtest, PlaytestStep) {
    let mut red = red();
    // Haste is a keyword line the parser reads from Scryfall's keywords.
    red[1].keywords = vec!["Haste".into()];
    Playtest::new(&you, &[], &red, &[], seed, Difficulty::VeryEasy).expect("a game starts")
}

/// Issue #991: the reader's token is offered and drawn in the printing their deck sets for it.
#[test]
fn a_token_is_offered_and_drawn_in_the_printing_the_deck_sets() {
    let (preset, oracle, source) = crate::tokens::a_treasure();
    let token = crate::tokens::a_treasure_facts(&oracle, &source);
    let mut you = green();
    you.push(card(
        &source,
        Some("{1}{G}"),
        "Enchantment",
        "",
        None,
        "G",
        1,
    ));
    let view = engine(move || {
        let (mut game, _) =
            Playtest::new(&you, &[token], &red(), &[], 2, Difficulty::VeryEasy).unwrap();
        game.act(A::Keep { bottom: vec![] }).unwrap();
        game.act(A::CreateToken { preset, count: 1 }).unwrap().view
    });
    let offer = view.tokens.iter().find(|t| t.name == "Treasure").unwrap();
    assert_eq!(offer.card_id.as_deref(), Some("deck-treasure"));
    let made = view.you.battlefield.iter().find(|c| c.is_token).unwrap();
    assert_eq!(made.card_id.as_deref(), Some("deck-treasure"));
}

/// A game past the reader's opening hand, kept at seven, at the reader's first main phase.
fn kept(seed: u64) -> (Playtest, PlaytestStep) {
    let (mut game, _) = deal(green(), seed);
    let step = game.act(A::Keep { bottom: vec![] }).expect("keep seven");
    (game, step)
}

fn find<'a>(cards: &'a [GameCard], name: &str) -> Option<&'a GameCard> {
    cards.iter().find(|c| c.name == name)
}

/// Draw (by hand) until the reader holds `name`, so a test does not depend on the shuffle.
fn in_hand(game: &mut Playtest, name: &str) -> u64 {
    for _ in 0..60 {
        if let Some(c) = find(&game.view().you.hand, name) {
            return c.id;
        }
        game.act(A::Draw { count: 1 }).expect("draw");
    }
    panic!("never drew {name}");
}

/// Put a card from the reader's hand onto the battlefield by hand.
fn put_down(game: &mut Playtest, name: &str) {
    let id = in_hand(game, name);
    game.act(A::Move {
        id,
        to: Place::Battlefield,
    })
    .expect("put down");
}

/// End the reader's turn and answer whatever is in their way until their next main phase: no
/// blocks, and the AI's choice for any question.
fn to_main(game: &mut Playtest) -> PlaytestStep {
    let mut step = game.act(A::EndTurn).expect("end turn");
    // A turn may stop more than once (a response, a block): every step's facts are kept.
    let mut happened = std::mem::take(&mut step.happened);
    for _ in 0..40 {
        let action = match step.view.stage {
            Stage::Main | Stage::Over => {
                step.happened = happened;
                return step;
            }
            Stage::Attack => A::Attack { attacks: vec![] },
            Stage::Block => A::Block { blocks: vec![] },
            Stage::Respond => A::Pass,
            Stage::Watching => panic!("a step's own view is never a frame's"),
            Stage::Prompt => A::Auto,
            Stage::Mulligan => A::Keep { bottom: vec![] },
        };
        step = game.act(action).expect("play on");
        happened.append(&mut step.happened);
    }
    panic!("never came back to the main phase");
}

#[test]
fn a_new_game_waits_on_the_opening_hand_and_hides_the_opponents_cards() {
    let view: PlaytestView = engine(|| deal(green(), 2).1.view);
    assert_eq!(view.stage, Stage::Mulligan);
    assert_eq!(
        view.turn, 0,
        "no turn has begun while the hands are decided"
    );
    assert_eq!(view.you.hand.len(), 7);
    assert_eq!(view.you.life, 20, "no commander: a freeform game at 20");
    assert_eq!(view.opponent.life, 20);
    assert!(view.mulligan.is_some());
    assert!(
        view.opponent.hand.is_empty(),
        "the opponent's hand is a count"
    );
    assert!(view.opponent.library_cards.is_empty());
    // The AI has decided its own hand (it may have mulliganed): what it holds is a count.
    assert!((5..=7).contains(&view.opponent.hand_count));
    assert_eq!(view.opponent.hand_count + view.opponent.library, 40);
    assert_eq!(view.you.library_cards.len(), 40 - 7);
    assert!(view.you.hand.iter().all(|c| c.card_id.is_some()));
    assert_eq!(
        view.started,
        Seat::You,
        "an even seed puts the reader on the play"
    );
}

#[test]
fn keeping_on_the_play_stops_at_the_readers_first_main_phase() {
    let step = engine(|| kept(2).1);
    assert_eq!(step.view.stage, Stage::Main);
    assert_eq!(step.view.active, Seat::You);
    assert_eq!(step.view.phase, PlaytestPhase::Main1);
    assert_eq!(step.view.turn, 1);
    assert_eq!(
        step.view.you.hand.len(),
        7,
        "the player on the play does not draw"
    );
    assert!(step.happened.contains(&H::Kept {
        size: 7,
        bottomed: 0
    }));
}

#[test]
fn keeping_on_the_draw_plays_the_ais_first_turn_and_hides_its_draw() {
    let step = engine(|| kept(3).1);
    assert_eq!(step.view.started, Seat::Opponent);
    assert_eq!(step.view.stage, Stage::Main);
    assert_eq!(step.view.active, Seat::You);
    assert_eq!(step.view.turn, 2);
    assert!(
        step.happened.contains(&H::TurnBegan {
            turn: 1,
            seat: Seat::Opponent
        }),
        "{:?}",
        step.happened
    );
    assert!(
        step.happened.iter().any(|h| matches!(
            h,
            H::Played {
                seat: Seat::Opponent,
                ..
            }
        )),
        "the AI plays a land on its turn: {:?}",
        step.happened
    );
    assert!(step.happened.contains(&H::Drew {
        seat: Seat::You,
        name: step.view.you.hand.last().map(|c| c.name.clone()),
    }));
    assert!(
        !step.happened.iter().any(|h| matches!(
            h,
            H::Drew {
                seat: Seat::Opponent,
                name: Some(_)
            }
        )),
        "an opponent's draw names no card"
    );
}

#[test]
fn a_land_is_played_by_the_land_drop_and_a_second_is_refused_unchanged() {
    let (first, refused, view) = engine(|| {
        let (mut game, _) = kept(2);
        let a = in_hand(&mut game, "Forest");
        let first = game.act(A::Play { id: a }).unwrap();
        let b = in_hand(&mut game, "Forest");
        let before = game.view();
        let refused = game.act(A::Play { id: b });
        assert_eq!(game.view(), before, "a refusal changes nothing");
        (first, refused, game.view())
    });
    assert!(first.happened.contains(&H::Played {
        seat: Seat::You,
        name: "Forest".into()
    }));
    assert_eq!(first.view.you.mana_open, 1);
    let forest = find(&first.view.you.battlefield, "Forest").unwrap();
    assert_eq!(forest.lane, Lane::Land);
    assert_eq!(forest.card_id.as_deref(), Some("print-forest"));
    assert!(refused.unwrap_err().contains("can't be played right now"));
    assert_eq!(view.stage, Stage::Main);
}

#[test]
fn a_creature_is_cast_from_untapped_mana_and_resolves_past_the_ai() {
    let step = engine(|| {
        let (mut game, _) = kept(2);
        put_down(&mut game, "Forest");
        let land = in_hand(&mut game, "Forest");
        game.act(A::Play { id: land }).unwrap();
        let bear = in_hand(&mut game, "Grizzly Bears");
        game.act(A::Play { id: bear }).unwrap()
    });
    assert!(step.happened.contains(&H::Cast {
        seat: Seat::You,
        name: "Grizzly Bears".into()
    }));
    assert_eq!(
        step.view.stage,
        Stage::Main,
        "back to the main phase, the stack empty"
    );
    assert!(step.view.stack.is_empty());
    let bear = find(&step.view.you.battlefield, "Grizzly Bears").unwrap();
    assert_eq!(bear.card_id.as_deref(), Some("print-grizzly-bears"));
    assert_eq!(step.view.you.mana_open, 0);
}

#[test]
fn a_spell_with_a_choice_of_targets_asks_and_is_cast_at_the_answer() {
    let (asked, cast) = engine(|| {
        let mut deck = green();
        deck.extend(
            red()
                .into_iter()
                .filter(|c| c.name == "Lightning Bolt" || c.name == "Mountain"),
        );
        let (mut game, _) = deal(deck, 2);
        game.act(A::Keep { bottom: vec![] }).unwrap();
        let mountain = in_hand(&mut game, "Mountain");
        game.act(A::Play { id: mountain }).unwrap();
        let bolt = in_hand(&mut game, "Lightning Bolt");
        let asked = game.act(A::Play { id: bolt }).unwrap();
        let prompt = asked.view.prompt.clone().expect("a prompt");
        let at_face = prompt
            .options
            .iter()
            .find(|o| o.players == vec![Seat::Opponent])
            .expect("the opponent is a target");
        let cast = game
            .act(A::Choose {
                index: at_face.index,
            })
            .unwrap();
        (asked, cast)
    });
    assert_eq!(asked.view.stage, Stage::Prompt);
    let prompt = asked.view.prompt.unwrap();
    // phase asks either way: one cast per target (the board's own question), or one cast and
    // then its own target prompt. Both read the same to the reader.
    assert!(
        ["CastChoice", "TargetSelection"].contains(&prompt.kind.as_str()),
        "{}",
        prompt.kind
    );
    assert_eq!(prompt.source.as_deref(), Some("Lightning Bolt"));
    assert!(prompt.cancellable);
    assert!(prompt.options.iter().any(|o| o.players == vec![Seat::You]));

    assert_eq!(cast.view.stage, Stage::Main);
    assert_eq!(cast.view.opponent.life, 17);
    assert!(cast.happened.contains(&H::Life {
        seat: Seat::Opponent,
        amount: -3,
        total: 17,
    }));
    assert!(find(&cast.view.you.graveyard, "Lightning Bolt").is_some());
}

#[test]
fn a_cast_with_a_question_is_taken_back_by_cancel() {
    let (asked, cancelled) = engine(|| {
        let mut deck = green();
        deck.extend(
            red()
                .into_iter()
                .filter(|c| c.name == "Lightning Bolt" || c.name == "Mountain"),
        );
        let (mut game, _) = deal(deck, 2);
        game.act(A::Keep { bottom: vec![] }).unwrap();
        let mountain = in_hand(&mut game, "Mountain");
        game.act(A::Play { id: mountain }).unwrap();
        let bolt = in_hand(&mut game, "Lightning Bolt");
        let asked = game.act(A::Play { id: bolt }).unwrap();
        let refused = game.act(A::Pass);
        assert!(
            refused.is_err(),
            "the question is answered or cancelled first"
        );
        let cancelled = game.act(A::Cancel).unwrap();
        (asked, cancelled)
    });
    assert_eq!(asked.view.stage, Stage::Prompt);
    assert_eq!(cancelled.view.stage, Stage::Main);
    assert!(find(&cancelled.view.you.hand, "Lightning Bolt").is_some());
    assert_eq!(cancelled.view.you.mana_open, 1, "nothing was paid");
    assert_eq!(cancelled.view.opponent.life, 20);
}

#[test]
fn a_creature_attacks_the_opponent_and_the_turn_stops_in_the_second_main_phase() {
    let (offered, attacked) = engine(|| {
        let (mut game, _) = kept(2);
        put_down(&mut game, "Grizzly Bears");
        // A turn cycle, so the bears are no longer summoning sick.
        let step = game.act(A::EndTurn).unwrap();
        assert_eq!(step.view.active, Seat::You);
        assert_eq!(step.view.phase, PlaytestPhase::Main1);
        let offered = game.act(A::Pass).unwrap();
        let bears: Vec<u64> = offered
            .view
            .you
            .battlefield
            .iter()
            .filter(|c| c.name == "Grizzly Bears")
            .map(|c| c.id)
            .collect();
        let attacks = bears
            .into_iter()
            .map(|attacker| PlaytestAttackPair {
                attacker,
                target: None,
            })
            .collect();
        let attacked = game.act(A::Attack { attacks }).unwrap();
        (offered, attacked)
    });
    assert_eq!(offered.view.stage, Stage::Attack);
    let bear = find(&offered.view.you.battlefield, "Grizzly Bears")
        .unwrap()
        .id;
    let attack = offered.view.attack.as_ref().unwrap();
    assert_eq!(attack.attackers.len(), 1);
    assert_eq!(attack.attackers[0].id, bear);
    assert!(
        attack.attackers[0].player,
        "the bears can attack the opponent"
    );
    assert!(
        attack.targets.is_empty(),
        "the opponent has no planeswalker"
    );
    assert!(attacked.happened.contains(&H::Attacked {
        seat: Seat::You,
        names: vec!["Grizzly Bears".into()]
    }));
    let blocked = attacked
        .happened
        .iter()
        .any(|h| matches!(h, H::Blocked { .. }));
    if !blocked {
        assert_eq!(attacked.view.opponent.life, 18, "{:?}", attacked.happened);
    }
    if attacked.view.stage == Stage::Main {
        assert_eq!(attacked.view.phase, PlaytestPhase::Main2);
    }
}

#[test]
fn the_ai_attacks_and_the_reader_blocks() {
    // The AI attacks a board it can hit: the reader's side is a single 1/1 elf.
    let found = engine(|| {
        for seed in [3u64, 5, 7, 9, 11, 13] {
            let (mut game, _) = kept(seed);
            for _ in 0..8 {
                let step = to_main_or_block(&mut game);
                if step.view.stage == Stage::Block {
                    let block = step.view.block.clone().unwrap();
                    let Some(blocker) = block.blockers.iter().find(|b| !b.attackers.is_empty())
                    else {
                        continue;
                    };
                    let pair = PlaytestBlockPair {
                        blocker: blocker.id,
                        attacker: blocker.attackers[0],
                    };
                    let after = game.act(A::Block { blocks: vec![pair] }).unwrap();
                    return Some((step, after));
                }
                if step.view.stage == Stage::Over {
                    break;
                }
                if step
                    .view
                    .you
                    .battlefield
                    .iter()
                    .all(|c| c.name != "Llanowar Elves")
                {
                    put_down(&mut game, "Llanowar Elves");
                }
            }
        }
        None
    });
    let (asked, after) = found.expect("the AI attacked into a blocker in one of the games");
    let combat = asked.view.combat.expect("combat is on");
    assert!(!combat.attacks.is_empty());
    assert!(
        after.happened.iter().any(|h| matches!(
            h,
            H::Blocked {
                seat: Seat::You,
                ..
            }
        )),
        "{:?}",
        after.happened
    );
}

/// Pass on until the reader blocks, or it is their main phase again.
fn to_main_or_block(game: &mut Playtest) -> PlaytestStep {
    let mut step = game.act(A::EndTurn).expect("end turn");
    for _ in 0..40 {
        let action = match step.view.stage {
            Stage::Main | Stage::Over | Stage::Block => return step,
            Stage::Attack => A::Attack { attacks: vec![] },
            Stage::Respond => A::Pass,
            Stage::Watching => panic!("a step's own view is never a frame's"),
            Stage::Prompt => A::Auto,
            Stage::Mulligan => A::Keep { bottom: vec![] },
        };
        step = game.act(action).expect("play on");
    }
    panic!("never came back to the reader");
}

#[test]
fn the_ai_plays_its_deck_over_several_turns() {
    let (turns, opponent_played) = engine(|| {
        let (mut game, _) = kept(2);
        let mut opponent_played = Vec::new();
        let mut turn = 1;
        for _ in 0..6 {
            let land = find(&game.view().you.hand, "Forest").map(|c| c.id);
            if let Some(id) = land {
                game.act(A::Play { id }).unwrap();
            }
            let step = to_main(&mut game);
            opponent_played.extend(step.happened.into_iter().filter(|h| {
                matches!(
                    h,
                    H::Played {
                        seat: Seat::Opponent,
                        ..
                    } | H::Cast {
                        seat: Seat::Opponent,
                        ..
                    }
                )
            }));
            turn = step.view.turn;
            if step.view.stage == Stage::Over {
                break;
            }
        }
        (turn, opponent_played)
    });
    assert!(
        turns >= 9,
        "six of the reader's turns, the AI's between them: {turns}"
    );
    assert!(
        opponent_played
            .iter()
            .filter(|h| matches!(h, H::Played { .. }))
            .count()
            >= 3,
        "{opponent_played:?}"
    );
    assert!(
        opponent_played.iter().any(|h| matches!(h, H::Cast { .. })),
        "the AI casts its spells: {opponent_played:?}"
    );
}

#[test]
fn a_medium_ai_plays_a_turn() {
    let step = engine(|| {
        let mut red = red();
        red[1].keywords = vec!["Haste".into()];
        let (mut game, _) = Playtest::new(&green(), &[], &red, &[], 3, Difficulty::Medium).unwrap();
        game.act(A::Keep { bottom: vec![] }).unwrap()
    });
    assert_eq!(step.view.active, Seat::You);
    assert!(step.happened.iter().any(|h| matches!(
        h,
        H::Played {
            seat: Seat::Opponent,
            ..
        }
    )));
}

#[test]
fn the_opponent_at_zero_life_ends_the_game_and_the_board_refuses_more() {
    let (over, refused) = engine(|| {
        let (mut game, _) = kept(2);
        let over = game
            .act(A::SetLife {
                seat: Seat::Opponent,
                life: 0,
            })
            .unwrap();
        let refused = game.act(A::Pass);
        (over, refused)
    });
    assert_eq!(over.view.stage, Stage::Over);
    assert_eq!(over.view.winner, Some(Seat::You));
    assert!(over.happened.contains(&H::GameOver {
        winner: Some(Seat::You)
    }));
    assert!(refused.unwrap_err().contains("game is over"));
}

#[test]
fn the_sandbox_is_the_readers_main_phase_and_the_readers_cards() {
    engine(|| {
        let (mut game, step) = kept(3);
        // The AI's turn put its land on the battlefield; the reader may not move it.
        let theirs = step.view.opponent.battlefield[0].id;
        assert!(game
            .act(A::Move {
                id: theirs,
                to: Place::Hand
            })
            .is_err());
        let to_attack = game.act(A::Pass).unwrap();
        if to_attack.view.stage != Stage::Main {
            assert!(game.act(A::Draw { count: 1 }).is_err());
        }
    });
}

#[test]
fn the_same_seed_and_decks_play_the_same_game() {
    let (a, b) = engine(|| (kept(5).1, kept(5).1));
    assert_eq!(a.view, b.view);
    assert_eq!(a.happened, b.happened);
}

#[test]
fn a_stop_the_reader_asked_for_stops_the_opponents_turn_and_end_turn_skips_it() {
    let (stopped, passed, ended) = engine(|| {
        let (mut game, _) = kept(2);
        let upkeep = PlaytestStop {
            seat: Seat::Opponent,
            step: PlaytestStopStep::Upkeep,
        };
        let set = game
            .act(A::SetStops {
                stops: vec![upkeep],
            })
            .unwrap();
        assert_eq!(set.view.stops, vec![upkeep]);
        assert_eq!(set.view.stage, Stage::Main, "a setting plays nothing on");
        // Pass the first main phase, and the second: the opponent's upkeep is the next stop.
        let mut step = game.act(A::Pass).unwrap();
        while step.view.stage == Stage::Main && step.view.active == Seat::You {
            step = game.act(A::Pass).unwrap();
        }
        let stopped = step;
        let passed = game.act(A::Pass).unwrap();
        // The reader's next turn, ended at once: the opponent's upkeep is skipped this time.
        let mut step = passed.clone();
        while step.view.active != Seat::You || step.view.stage != Stage::Main {
            step = match step.view.stage {
                Stage::Block => game.act(A::Block { blocks: vec![] }).unwrap(),
                Stage::Prompt => game.act(A::Auto).unwrap(),
                _ => game.act(A::Pass).unwrap(),
            };
        }
        let ended = game.act(A::EndTurn).unwrap();
        (stopped, passed, ended)
    });
    assert_eq!(stopped.view.stage, Stage::Respond);
    assert_eq!(stopped.view.active, Seat::Opponent);
    assert_eq!(stopped.view.phase, PlaytestPhase::Beginning);
    assert_ne!(
        passed.view.stage,
        Stage::Respond,
        "the stop is once per step"
    );
    assert!(
        !(ended.view.stage == Stage::Respond && ended.view.phase == PlaytestPhase::Beginning),
        "ending the turn passes the opponent's upkeep too: {:?}",
        ended.view.stage
    );
}

#[test]
fn a_reader_with_a_trick_is_stopped_after_blocks() {
    let found = engine(|| {
        for seed in [3u64, 5, 7, 9, 11, 13, 15, 17] {
            let (mut game, _) = kept(seed);
            put_down(&mut game, "Forest");
            put_down(&mut game, "Llanowar Elves");
            in_hand(&mut game, "Giant Growth");
            for _ in 0..6 {
                let step = to_main_or_block(&mut game);
                if step.view.stage == Stage::Block {
                    let block = step.view.block.clone().unwrap();
                    let Some(blocker) = block.blockers.iter().find(|b| !b.attackers.is_empty())
                    else {
                        continue;
                    };
                    let pair = PlaytestBlockPair {
                        blocker: blocker.id,
                        attacker: blocker.attackers[0],
                    };
                    return Some(game.act(A::Block { blocks: vec![pair] }).unwrap());
                }
                if step.view.stage == Stage::Over {
                    break;
                }
            }
        }
        None
    });
    let after = found.expect("the AI attacked into a blocker in one of the games");
    assert_eq!(after.view.stage, Stage::Respond, "{:?}", after.happened);
    assert_eq!(after.view.phase, PlaytestPhase::Combat);
    assert!(after
        .view
        .combat
        .as_ref()
        .is_some_and(|c| !c.blocks.is_empty()));
}

#[test]
fn a_scry_is_answered_with_the_cards_kept_on_top() {
    let (asked, answered) = engine(|| {
        let mut deck = green();
        deck.push(card(
            "Island",
            None,
            "Basic Land — Island",
            "({T}: Add {U}.)",
            None,
            "U",
            4,
        ));
        deck.push(card(
            "Preordain",
            Some("{U}"),
            "Sorcery",
            "Scry 2, then draw a card.",
            None,
            "U",
            4,
        ));
        let (mut game, _) = deal(deck, 2);
        game.act(A::Keep { bottom: vec![] }).unwrap();
        let island = in_hand(&mut game, "Island");
        game.act(A::Play { id: island }).unwrap();
        let preordain = in_hand(&mut game, "Preordain");
        let asked = game.act(A::Play { id: preordain }).unwrap();
        let pick = asked.view.prompt.clone().unwrap().pick.expect("a pick");
        // Keep the second card on top; the first goes to the bottom.
        let kept = pick.cards[1].id;
        let answered = game.act(A::PickCards { ids: vec![kept] }).unwrap();
        (asked, (answered, kept))
    });
    assert_eq!(asked.view.stage, Stage::Prompt);
    let prompt = asked.view.prompt.unwrap();
    assert_eq!(prompt.kind, "ScryChoice");
    let pick = prompt.pick.unwrap();
    assert_eq!(pick.purpose, PlaytestPickPurpose::Scry);
    assert_eq!((pick.cards.len(), pick.min, pick.max), (2, 0, 2));
    assert!(pick.ordered);
    let (answered, kept) = answered;
    assert_eq!(answered.view.stage, Stage::Main);
    assert!(
        answered.view.you.hand.iter().any(|c| c.id == kept),
        "the card kept on top is the one drawn"
    );
}

#[test]
fn a_pick_out_of_bounds_is_refused_unchanged() {
    engine(|| {
        let mut deck = green();
        deck.push(card(
            "Island",
            None,
            "Basic Land — Island",
            "({T}: Add {U}.)",
            None,
            "U",
            4,
        ));
        deck.push(card(
            "Preordain",
            Some("{U}"),
            "Sorcery",
            "Scry 2, then draw a card.",
            None,
            "U",
            4,
        ));
        let (mut game, _) = deal(deck, 2);
        game.act(A::Keep { bottom: vec![] }).unwrap();
        let island = in_hand(&mut game, "Island");
        game.act(A::Play { id: island }).unwrap();
        let preordain = in_hand(&mut game, "Preordain");
        let asked = game.act(A::Play { id: preordain }).unwrap();
        let pick = asked.view.prompt.unwrap().pick.unwrap();
        let before = game.view();
        let twice = pick.cards[0].id;
        assert!(game
            .act(A::PickCards {
                ids: vec![twice, twice]
            })
            .is_err());
        assert!(game.act(A::PickCards { ids: vec![999_999] }).is_err());
        assert_eq!(game.view(), before);
    });
}

#[test]
fn a_creature_attacks_the_opponents_planeswalker() {
    let (offered, attacked, walker) = engine(|| {
        let mut red = red();
        let mut walker = card(
            "Test Walker",
            Some("{2}{R}"),
            "Legendary Planeswalker — Chandra",
            "+1: Test Walker deals 1 damage to each opponent.",
            None,
            "R",
            1,
        );
        walker.loyalty = Some("5".into());
        red.push(walker);
        let (mut game, _) = Playtest::new(&green(), &[], &red, &[], 2, Difficulty::VeryEasy)
            .expect("a game starts");
        game.act(A::Keep { bottom: vec![] }).unwrap();
        game.put_for_test(AI_SEAT, "Test Walker");
        put_down(&mut game, "Grizzly Bears");
        game.act(A::EndTurn).unwrap();
        let mut offered = game.act(A::Pass).unwrap();
        while offered.view.stage == Stage::Respond {
            offered = game.act(A::Pass).unwrap();
        }
        let walker = find(&offered.view.opponent.battlefield, "Test Walker")
            .expect("the walker is on the opponent's battlefield")
            .id;
        let bear = find(&offered.view.you.battlefield, "Grizzly Bears")
            .unwrap()
            .id;
        let attacked = game
            .act(A::Attack {
                attacks: vec![PlaytestAttackPair {
                    attacker: bear,
                    target: Some(walker),
                }],
            })
            .unwrap();
        (offered, attacked, walker)
    });
    assert_eq!(offered.view.stage, Stage::Attack);
    let attack = offered.view.attack.unwrap();
    assert!(attack.attackers[0].targets.contains(&walker));
    assert_eq!(attack.targets[0].name, "Test Walker");
    assert_eq!(
        attacked.view.opponent.life, 20,
        "the walker took it, not the player"
    );
    assert!(
        attacked.happened.iter().any(|h| matches!(
            h,
            H::Dealt { target, .. } if target == "Test Walker"
        )) || attacked
            .happened
            .iter()
            .any(|h| matches!(h, H::Blocked { .. }))
    );
}

#[test]
fn the_ais_turn_comes_back_as_replay_frames_that_hide_its_hand() {
    let step = engine(|| kept(3).1);
    assert!(
        !step.frames.is_empty(),
        "the AI's first turn is shown as it happens"
    );
    assert!(step.frames.iter().all(|f| f.view.stage == Stage::Watching));
    assert!(step.frames.iter().all(|f| f.view.prompt.is_none()
        && f.view.attack.is_none()
        && f.view.block.is_none()
        && f.view.opponent.hand.is_empty()));
    let told: Vec<_> = step
        .frames
        .iter()
        .flat_map(|f| f.happened.clone())
        .collect();
    assert!(told.iter().all(|h| step.happened.contains(h)));
    assert!(told.iter().any(|h| matches!(
        h,
        H::Played {
            seat: Seat::Opponent,
            ..
        }
    )));
}
