//! Playtest games end to end — a green deck against a red one played by phase's AI — every test
//! on the engine's stack. The AI plays at `VeryEasy` unless a test says otherwise: its other
//! presets search with a 1.5 s budget a decision, and these tests are about the session. A game
//! against the AI starts with the sandbox off, so a test that arranges the table by hand turns it
//! on for that (`by_hand`) and back off; `goldfish_tests.rs` has the game against the goldfish.

use engine::game::create_object;
use engine::types::ability::{Effect, KeywordAction, ResolvedAbility, TargetRef};
use engine::types::game_state::{StackEntry, StackEntryKind};
use engine::types::identifiers::{CardId, ObjectId};
use engine::types::zones::Zone;
use engine::types::{GameState, PlayerId};

use crate::cards::CardFacts;
use crate::on_engine_stack;
use crate::view::{GameCard, Lane, Place, Seat};

use super::session::{stack_targets, OpponentDeck, Playtest};
use super::view::{
    Difficulty, PlaytestAction as A, PlaytestAttackPair, PlaytestBlockPair, PlaytestHappened as H,
    PlaytestPhase, PlaytestPickPurpose, PlaytestPlayer, PlaytestStage as Stage, PlaytestStep,
    PlaytestStop, PlaytestStopStep, PlaytestView,
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
const AI_SEAT: PlaytestPlayer = PlaytestPlayer::Opponent;

/// A duel's one opponent: `cards`, with no tokens of its own.
fn against(cards: Vec<CardFacts>) -> Vec<OpponentDeck> {
    vec![OpponentDeck {
        cards,
        tokens: Vec::new(),
    }]
}

fn engine<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> T {
    on_engine_stack(work).expect("the engine ran")
}

/// A game. An even seed puts the reader on the play.
fn deal(you: Vec<CardFacts>, seed: u64) -> (Playtest, PlaytestStep) {
    let mut red = red();
    // Haste is a keyword line the parser reads from Scryfall's keywords.
    red[1].keywords = vec!["Haste".into()];
    Playtest::new(&you, &[], &against(red), seed, Difficulty::VeryEasy).expect("a game starts")
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
            Playtest::new(&you, &[token], &against(red()), 2, Difficulty::VeryEasy).unwrap();
        game.act(A::Keep { bottom: vec![] }).unwrap();
        game.act(A::SetSandbox { on: true }).unwrap();
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

/// `work` with the sandbox on, and the sandbox as it was after: how a test arranges the table by
/// hand without leaving a game against the AI any less strict than it found it.
fn by_hand<T>(game: &mut Playtest, work: impl FnOnce(&mut Playtest) -> T) -> T {
    let was = game.view().sandbox;
    game.act(A::SetSandbox { on: true }).expect("sandbox on");
    let out = work(game);
    game.act(A::SetSandbox { on: was }).expect("sandbox back");
    out
}

/// Draw (by hand) until the reader holds `name`, so a test does not depend on the shuffle.
fn in_hand(game: &mut Playtest, name: &str) -> u64 {
    by_hand(game, |game| {
        for _ in 0..60 {
            if let Some(c) = find(&game.view().you.hand, name) {
                return c.id;
            }
            game.act(A::Draw { count: 1 }).expect("draw");
        }
        panic!("never drew {name}");
    })
}

/// Put a card from the reader's hand onto the battlefield by hand.
fn put_down(game: &mut Playtest, name: &str) {
    let id = in_hand(game, name);
    by_hand(game, |game| {
        game.act(A::Move {
            id,
            to: Place::Battlefield,
        })
        .expect("put down")
    });
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
    assert_eq!(view.opponents[0].life, 20);
    assert!(view.mulligan.is_some());
    assert!(
        view.opponents[0].hand.is_empty(),
        "the opponent's hand is a count"
    );
    assert!(view.opponents[0].library_cards.is_empty());
    // The AI has decided its own hand (it may have mulliganed): what it holds is a count.
    assert!((5..=7).contains(&view.opponents[0].hand_count));
    assert_eq!(view.opponents[0].hand_count + view.opponents[0].library, 40);
    assert_eq!(view.you.library_cards.len(), 40 - 7);
    assert!(view.you.hand.iter().all(|c| c.card_id.is_some()));
    assert_eq!(
        view.started,
        PlaytestPlayer::You,
        "an even seed puts the reader on the play"
    );
}

#[test]
fn keeping_on_the_play_stops_at_the_readers_first_main_phase() {
    let step = engine(|| kept(2).1);
    assert_eq!(step.view.stage, Stage::Main);
    assert_eq!(step.view.active, PlaytestPlayer::You);
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
    assert_eq!(step.view.started, PlaytestPlayer::Opponent);
    assert_eq!(step.view.stage, Stage::Main);
    assert_eq!(step.view.active, PlaytestPlayer::You);
    assert_eq!(step.view.turn, 2);
    assert!(
        step.happened.contains(&H::TurnBegan {
            turn: 1,
            seat: PlaytestPlayer::Opponent
        }),
        "{:?}",
        step.happened
    );
    assert!(
        step.happened.iter().any(|h| matches!(
            h,
            H::Played {
                seat: PlaytestPlayer::Opponent,
                ..
            }
        )),
        "the AI plays a land on its turn: {:?}",
        step.happened
    );
    assert!(step.happened.contains(&H::Drew {
        seat: PlaytestPlayer::You,
        name: step.view.you.hand.last().map(|c| c.name.clone()),
    }));
    assert!(
        !step.happened.iter().any(|h| matches!(
            h,
            H::Drew {
                seat: PlaytestPlayer::Opponent,
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
        seat: PlaytestPlayer::You,
        name: "Forest".into()
    }));
    assert_eq!(first.view.you.mana_open, 1);
    assert_eq!(
        first.view.you.mana.open.green, 1,
        "the mana table has the Forest's green"
    );
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
        seat: PlaytestPlayer::You,
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
            .find(|o| o.players == vec![PlaytestPlayer::Opponent])
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
    assert!(prompt
        .options
        .iter()
        .any(|o| o.players == vec![PlaytestPlayer::You]));

    assert_eq!(cast.view.stage, Stage::Main);
    assert_eq!(cast.view.opponents[0].life, 17);
    assert!(cast.happened.contains(&H::Life {
        seat: PlaytestPlayer::Opponent,
        amount: -3,
        total: 17,
    }));
    assert!(find(&cast.view.you.graveyard, "Lightning Bolt").is_some());
}

/// Issue #1071: a stack item names what it targets, for the board's arrows — its follow-on
/// abilities' targets too, each once, and never a card the reader may not see.
#[test]
fn a_stack_item_names_the_targets_the_table_shows() {
    let (spell, equip) = engine(|| {
        let mut state = GameState::new_two_player(7);
        let goblin = create_object(
            &mut state,
            CardId(1),
            PlayerId(1),
            "Raging Goblin".into(),
            Zone::Battlefield,
        );
        let hidden = create_object(
            &mut state,
            CardId(2),
            PlayerId(1),
            "Llanowar Elves".into(),
            Zone::Hand,
        );
        let bolt = create_object(
            &mut state,
            CardId(3),
            PlayerId(0),
            "Lightning Bolt".into(),
            Zone::Stack,
        );
        let effect = || Effect::Unimplemented {
            name: "test".into(),
            description: None,
        };
        let ability = ResolvedAbility::new(
            effect(),
            vec![
                TargetRef::Object(goblin),
                TargetRef::Object(hidden),
                TargetRef::Player(PlayerId(1)),
            ],
            bolt,
            PlayerId(0),
        )
        .sub_ability(ResolvedAbility::new(
            effect(),
            vec![TargetRef::Object(goblin), TargetRef::Player(PlayerId(0))],
            bolt,
            PlayerId(0),
        ));
        let spell = StackEntry {
            id: bolt,
            source_id: bolt,
            controller: PlayerId(0),
            kind: StackEntryKind::Spell {
                card_id: CardId(3),
                ability: Some(Box::new(ability)),
                casting_variant: Default::default(),
                actual_mana_spent: 1,
            },
        };
        let equip = StackEntry {
            id: ObjectId(900),
            source_id: ObjectId(901),
            controller: PlayerId(0),
            kind: StackEntryKind::KeywordAction {
                action: KeywordAction::Equip {
                    equipment_id: ObjectId(901),
                    target_creature_id: goblin,
                },
            },
        };
        (
            (goblin.0, stack_targets(&state, &spell)),
            stack_targets(&state, &equip),
        )
    });
    let (goblin, (cards, players)) = spell;
    assert_eq!(cards, vec![goblin], "the hand's card is never told");
    assert_eq!(
        players,
        vec![PlaytestPlayer::Opponent, PlaytestPlayer::You],
        "the sub-ability's player follows the spell's own"
    );
    assert_eq!(equip, (vec![goblin], vec![]));
}

/// Issue #999: a spell with one legal target is cast at it, with no question.
#[test]
fn a_spell_with_one_legal_target_is_cast_without_asking() {
    let (bear, cast) = engine(|| {
        let (mut game, _) = kept(2);
        put_down(&mut game, "Grizzly Bears");
        put_down(&mut game, "Forest");
        let bear = find(&game.view().you.battlefield, "Grizzly Bears")
            .unwrap()
            .id;
        assert!(game.view().opponents[0].battlefield.is_empty());
        let growth = in_hand(&mut game, "Giant Growth");
        (bear, game.act(A::Play { id: growth }).unwrap())
    });
    assert_eq!(cast.view.stage, Stage::Main, "{:?}", cast.view.prompt);
    assert!(find(&cast.view.you.graveyard, "Giant Growth").is_some());
    let grown = cast.view.you.battlefield.iter().find(|c| c.id == bear);
    assert_eq!(grown.and_then(|c| c.power), Some(5));
}

/// Issue #999: the second target of a spell, once only one is left for it, is taken without
/// asking. phase fills in a cast whose targets have one combination itself; a slot left with one
/// answer after the reader picked the first is the session's.
#[test]
fn a_target_slot_with_one_answer_left_is_taken_without_asking() {
    let (asked, answered) = engine(|| {
        let mut deck = green();
        deck.push(card(
            "Bear Brawl",
            Some("{1}{G}"),
            "Sorcery",
            "Target creature deals damage equal to its power to another target creature.",
            None,
            "G",
            4,
        ));
        let (mut game, _) = deal(deck, 2);
        game.act(A::Keep { bottom: vec![] }).unwrap();
        put_down(&mut game, "Grizzly Bears");
        put_down(&mut game, "Forest");
        put_down(&mut game, "Forest");
        game.put_for_test(AI_SEAT, "Raging Goblin");
        let brawl = in_hand(&mut game, "Bear Brawl");
        let asked = game.act(A::Play { id: brawl }).unwrap();
        let first = asked.view.prompt.clone().expect("which of two creatures");
        let bear = first
            .options
            .iter()
            .find(|o| o.cards.iter().any(|c| c.name == "Grizzly Bears"))
            .expect("a bear is offered")
            .index;
        (asked, game.act(A::Choose { index: bear }).unwrap())
    });
    assert_eq!(asked.view.stage, Stage::Prompt);
    assert_eq!(
        answered.view.stage,
        Stage::Main,
        "{:?}",
        answered.view.prompt
    );
    assert!(answered.happened.contains(&H::Chose {
        what: "TargetSelection".into()
    }));
    assert!(find(&answered.view.opponents[0].graveyard, "Raging Goblin").is_some());
    assert!(find(&answered.view.you.graveyard, "Bear Brawl").is_some());
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
    assert_eq!(cancelled.view.opponents[0].life, 20);
}

#[test]
fn a_creature_attacks_the_opponent_and_the_turn_stops_in_the_second_main_phase() {
    let (offered, attacked) = engine(|| {
        let (mut game, _) = kept(2);
        put_down(&mut game, "Grizzly Bears");
        // A turn cycle, so the bears are no longer summoning sick.
        let step = game.act(A::EndTurn).unwrap();
        assert_eq!(step.view.active, PlaytestPlayer::You);
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
                player: None,
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
    assert_eq!(
        attack.attackers[0].players,
        vec![PlaytestPlayer::Opponent],
        "the bears can attack the opponent"
    );
    assert!(
        attack.targets.is_empty(),
        "the opponent has no planeswalker"
    );
    assert!(attacked.happened.contains(&H::Attacked {
        seat: PlaytestPlayer::You,
        names: vec!["Grizzly Bears".into()]
    }));
    let blocked = attacked
        .happened
        .iter()
        .any(|h| matches!(h, H::Blocked { .. }));
    if !blocked {
        assert_eq!(
            attacked.view.opponents[0].life, 18,
            "{:?}",
            attacked.happened
        );
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
                seat: PlaytestPlayer::You,
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
                        seat: PlaytestPlayer::Opponent,
                        ..
                    } | H::Cast {
                        seat: PlaytestPlayer::Opponent,
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
        let (mut game, _) =
            Playtest::new(&green(), &[], &against(red), 3, Difficulty::Medium).unwrap();
        game.act(A::Keep { bottom: vec![] }).unwrap()
    });
    assert_eq!(step.view.active, PlaytestPlayer::You);
    assert!(step.happened.iter().any(|h| matches!(
        h,
        H::Played {
            seat: PlaytestPlayer::Opponent,
            ..
        }
    )));
}

#[test]
fn the_opponent_at_zero_life_ends_the_game_and_the_board_refuses_more() {
    let (over, refused) = engine(|| {
        let (mut game, _) = kept(2);
        game.act(A::SetSandbox { on: true }).unwrap();
        let over = game
            .act(A::SetLife {
                seat: PlaytestPlayer::Opponent,
                life: 0,
            })
            .unwrap();
        let refused = game.act(A::Pass);
        (over, refused)
    });
    assert_eq!(over.view.stage, Stage::Over);
    assert_eq!(over.view.winner, Some(PlaytestPlayer::You));
    assert!(over.happened.contains(&H::GameOver {
        winner: Some(PlaytestPlayer::You)
    }));
    assert!(refused.unwrap_err().contains("game is over"));
}

/// The owner's decision of 2026-10-17: against the AI the sandbox starts off, and while it is off
/// every hand on the table is refused, the game left as it was.
#[test]
fn the_sandbox_starts_off_against_the_ai_and_refuses_every_hand_edit() {
    let (start, refused, after) = engine(|| {
        let (mut game, step) = kept(3);
        let id = step.view.you.hand[0].id;
        let refused = [
            game.act(A::Draw { count: 1 }),
            game.act(A::Move {
                id,
                to: Place::Graveyard,
            }),
            game.act(A::SetLife {
                seat: PlaytestPlayer::Opponent,
                life: 1,
            }),
            game.act(A::UntapAll),
        ];
        (step.view, refused, game.view())
    });
    assert!(!start.sandbox && !start.goldfish);
    for r in refused {
        assert!(r.unwrap_err().contains("sandbox"));
    }
    assert_eq!(after.you.hand, start.you.hand);
    assert_eq!(after.opponents[0].life, start.opponents[0].life);
}

/// With the sandbox on, the reader's hand reaches every card the table shows — an opponent's land
/// too, back to its owner's hand — but never one they cannot see, and only in their main phase.
#[test]
fn the_sandbox_reaches_the_table_but_not_an_opponents_hidden_cards() {
    engine(|| {
        let (mut game, step) = kept(3);
        let on = game.act(A::SetSandbox { on: true }).unwrap();
        assert!(on.view.sandbox);
        assert!(on.happened.is_empty(), "a setting happens nothing");
        assert!(
            !on.view.can_undo || step.view.can_undo,
            "nor is it an action to undo"
        );
        // The AI's turn put its land on the battlefield; the sandbox may tap it and bounce it.
        let theirs = step.view.opponents[0].battlefield[0].clone();
        let tapped = game
            .act(A::Tap {
                ids: vec![theirs.id],
                tapped: !theirs.tapped,
            })
            .unwrap();
        assert!(tapped.happened.iter().any(|h| matches!(
            h,
            H::Tapped {
                seat: PlaytestPlayer::Opponent,
                ..
            }
        )));
        let bounced = game
            .act(A::Move {
                id: theirs.id,
                to: Place::Hand,
            })
            .unwrap();
        let left = &bounced.view.opponents[0].battlefield;
        assert!(left.iter().all(|c| c.id != theirs.id));
        assert_eq!(left.len() + 1, step.view.opponents[0].battlefield.len());
        assert_eq!(
            bounced.view.opponents[0].hand_count,
            step.view.opponents[0].hand_count + 1
        );
        assert!(bounced.happened.contains(&H::Put {
            seat: PlaytestPlayer::Opponent,
            name: theirs.name.clone(),
            from: Place::Battlefield,
            to: Place::Hand,
        }));
        // Now it is in a hand the reader cannot see: out of reach. Its id is the engine's; the
        // card keeps it in a hidden zone, which is exactly what must not be acted on.
        let hidden = game.act(A::Move {
            id: theirs.id,
            to: Place::Graveyard,
        });
        assert!(hidden.is_err());
        let to_attack = game.act(A::Pass).unwrap();
        if to_attack.view.stage != Stage::Main {
            assert!(game.act(A::Draw { count: 1 }).is_err());
        }
    });
}

/// With the sandbox on, a card the rules cannot play against the AI is put down unpaid, as on the
/// goldfish; with it off, the refusal says how to.
#[test]
fn a_card_the_rules_refuse_is_put_down_unpaid_only_in_the_sandbox() {
    let (refused, put) = engine(|| {
        let (mut game, _) = kept(2);
        let bear = in_hand(&mut game, "Grizzly Bears");
        let refused = game.act(A::Play { id: bear });
        game.act(A::SetSandbox { on: true }).unwrap();
        (refused, game.act(A::Play { id: bear }).unwrap())
    });
    assert!(refused.unwrap_err().contains("Turn the sandbox on"));
    assert!(find(&put.view.you.battlefield, "Grizzly Bears").is_some());
    assert!(put.happened.contains(&H::Put {
        seat: PlaytestPlayer::You,
        name: "Grizzly Bears".into(),
        from: Place::Hand,
        to: Place::Battlefield,
    }));
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
        while step.view.stage == Stage::Main && step.view.active == PlaytestPlayer::You {
            step = game.act(A::Pass).unwrap();
        }
        let stopped = step;
        let passed = game.act(A::Pass).unwrap();
        // The reader's next turn, ended at once: the opponent's upkeep is skipped this time.
        let mut step = passed.clone();
        while step.view.active != PlaytestPlayer::You || step.view.stage != Stage::Main {
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
    assert_eq!(stopped.view.active, PlaytestPlayer::Opponent);
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
        let (mut game, _) = Playtest::new(&green(), &[], &against(red), 2, Difficulty::VeryEasy)
            .expect("a game starts");
        game.act(A::Keep { bottom: vec![] }).unwrap();
        game.put_for_test(AI_SEAT, "Test Walker");
        put_down(&mut game, "Grizzly Bears");
        game.act(A::EndTurn).unwrap();
        let mut offered = game.act(A::Pass).unwrap();
        while offered.view.stage == Stage::Respond {
            offered = game.act(A::Pass).unwrap();
        }
        let walker = find(&offered.view.opponents[0].battlefield, "Test Walker")
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
                    player: None,
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
        attacked.view.opponents[0].life, 20,
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
        && f.view.opponents[0].hand.is_empty()));
    let told: Vec<_> = step
        .frames
        .iter()
        .flat_map(|f| f.happened.clone())
        .collect();
    assert!(told.iter().all(|h| step.happened.contains(h)));
    assert!(told.iter().any(|h| matches!(
        h,
        H::Played {
            seat: PlaytestPlayer::Opponent,
            ..
        }
    )));
}

// ── Four players (issue #994) ─────────────────────────────────────────────────────────────────

/// A four-player game, kept at seven: the reader against three red decks. A seed that is a
/// multiple of four puts the reader on the play.
fn four(seed: u64) -> (Playtest, PlaytestStep) {
    let mut red = red();
    red[1].keywords = vec!["Haste".into()];
    four_against(red, seed)
}

/// A four-player game, kept at seven, against three copies of `deck`.
fn four_against(deck: Vec<CardFacts>, seed: u64) -> (Playtest, PlaytestStep) {
    let opponents = vec![
        OpponentDeck {
            cards: deck,
            tokens: Vec::new(),
        };
        3
    ];
    let (mut game, _) = Playtest::new(&green(), &[], &opponents, seed, Difficulty::VeryEasy)
        .expect("a four-player game starts");
    let step = game.act(A::Keep { bottom: vec![] }).expect("keep seven");
    (game, step)
}

#[test]
fn a_four_player_game_seats_three_opponents_in_turn_order_and_hides_their_hands() {
    let (step, round) = engine(|| {
        let (mut game, step) = four(4);
        let round = to_main(&mut game);
        (step, round)
    });
    let view = &step.view;
    assert_eq!(view.started, PlaytestPlayer::You);
    assert_eq!(view.active, PlaytestPlayer::You);
    assert_eq!(
        view.opponents.iter().map(|o| o.player).collect::<Vec<_>>(),
        vec![
            PlaytestPlayer::Opponent,
            PlaytestPlayer::Opponent2,
            PlaytestPlayer::Opponent3
        ]
    );
    for seat in &view.opponents {
        assert_eq!(seat.life, 20);
        assert!(!seat.out);
        assert!(seat.hand.is_empty() && seat.library_cards.is_empty());
        assert_eq!(seat.hand_count, 7);
    }
    // Ending the turn plays each opponent's, in order, and comes back to the reader.
    let turns: Vec<PlaytestPlayer> = round
        .happened
        .iter()
        .filter_map(|h| match h {
            H::TurnBegan { seat, .. } => Some(*seat),
            _ => None,
        })
        .collect();
    assert_eq!(
        turns,
        vec![
            PlaytestPlayer::Opponent,
            PlaytestPlayer::Opponent2,
            PlaytestPlayer::Opponent3,
            PlaytestPlayer::You
        ]
    );
    assert_eq!(round.view.active, PlaytestPlayer::You);
    assert_eq!(round.view.stage, Stage::Main);
    for seat in [PlaytestPlayer::Opponent2, PlaytestPlayer::Opponent3] {
        assert!(
            round.happened.contains(&H::Drew { seat, name: None }),
            "{seat:?} drew, unnamed"
        );
    }
}

#[test]
fn a_four_player_game_goes_on_without_an_opponent_who_is_out() {
    let (out, last) = engine(|| {
        let (mut game, _) = four(4);
        game.act(A::SetSandbox { on: true }).unwrap();
        let out = game
            .act(A::SetLife {
                seat: PlaytestPlayer::Opponent2,
                life: 0,
            })
            .unwrap();
        for seat in [PlaytestPlayer::Opponent, PlaytestPlayer::Opponent3] {
            game.act(A::SetLife { seat, life: 0 }).unwrap();
        }
        (out, game.view())
    });
    assert_eq!(out.view.stage, Stage::Main, "{:?}", out.happened);
    assert!(out.view.opponents[1].out);
    assert!(!out.view.opponents[0].out && !out.view.opponents[2].out);
    assert!(out.happened.contains(&H::Eliminated {
        seat: PlaytestPlayer::Opponent2
    }));
    assert_eq!(last.stage, Stage::Over);
    assert_eq!(last.winner, Some(PlaytestPlayer::You));
}

#[test]
fn the_reader_out_of_a_four_player_game_has_lost_it() {
    let (out, refused) = engine(|| {
        let (mut game, _) = four(4);
        game.act(A::SetSandbox { on: true }).unwrap();
        let out = game
            .act(A::SetLife {
                seat: PlaytestPlayer::You,
                life: 0,
            })
            .unwrap();
        (out, game.act(A::Pass))
    });
    assert_eq!(out.view.stage, Stage::Over);
    assert!(out.view.you.out);
    assert_eq!(out.view.winner, None);
    assert!(out.happened.contains(&H::Eliminated {
        seat: PlaytestPlayer::You
    }));
    assert!(refused.unwrap_err().contains("game is over"));
}

#[test]
fn an_attack_names_the_opponent_it_is_at() {
    let (offered, attacked) = engine(|| {
        // Opponents with lands alone, so nothing of theirs answers the bears.
        let (mut game, _) = four_against(vec![red().swap_remove(0)], 4);
        put_down(&mut game, "Grizzly Bears");
        // A round of turns, so the bears are no longer summoning sick.
        to_main(&mut game);
        let offered = game.act(A::Pass).unwrap();
        let bear = find(&offered.view.you.battlefield, "Grizzly Bears")
            .unwrap()
            .id;
        let attacked = game
            .act(A::Attack {
                attacks: vec![PlaytestAttackPair {
                    attacker: bear,
                    target: None,
                    player: Some(PlaytestPlayer::Opponent3),
                }],
            })
            .unwrap();
        (offered, attacked)
    });
    let attack = offered.view.attack.as_ref().unwrap();
    assert_eq!(
        attack.attackers[0].players,
        vec![
            PlaytestPlayer::Opponent,
            PlaytestPlayer::Opponent2,
            PlaytestPlayer::Opponent3
        ]
    );
    let life = |p: usize| attacked.view.opponents[p].life;
    assert_eq!(
        (life(0), life(1), life(2)),
        (20, 20, 18),
        "{:?}",
        attacked.happened
    );
}

/// One to three opponents' decks — and none is the goldfish, not a refusal.
#[test]
fn a_game_has_up_to_three_opponents_and_none_is_the_goldfish() {
    let (none, four) = engine(|| {
        let none =
            Playtest::new(&green(), &[], &[], 4, Difficulty::VeryEasy).map(|(_, step)| step.view);
        let four = Playtest::new(
            &green(),
            &[],
            &vec![OpponentDeck::default(); 4],
            4,
            Difficulty::VeryEasy,
        )
        .err();
        (none, four)
    });
    let goldfish = none.expect("no opponents is a goldfish game");
    assert!(goldfish.goldfish && goldfish.sandbox);
    assert_eq!(goldfish.opponents.len(), 1);
    assert!(four.unwrap().contains("not 4"));
}

/// Issue #1027: two of the reader's triggers at once are put in order, and each answer names the
/// triggers in the order chosen — their sources and their words — rather than "Order triggers".
#[test]
fn two_triggers_at_once_are_ordered_by_answers_that_name_them() {
    let (asked, answered) = engine(|| {
        let mut deck = green();
        deck.push(card(
            "Dawn Scout",
            Some("{G}"),
            "Creature — Elf Scout",
            "Whenever Dawn Scout attacks, you gain 1 life.",
            Some(("1", "1")),
            "G",
            4,
        ));
        deck.push(card(
            "Dusk Scout",
            Some("{G}"),
            "Creature — Elf Scout",
            "Whenever Dusk Scout attacks, you gain 2 life.",
            Some(("1", "1")),
            "G",
            4,
        ));
        let (mut game, _) = deal(deck, 2);
        game.act(A::Keep { bottom: vec![] }).unwrap();
        put_down(&mut game, "Dawn Scout");
        put_down(&mut game, "Dusk Scout");
        // A turn cycle, so the scouts are no longer summoning sick.
        to_main(&mut game);
        let offered = game.act(A::Pass).unwrap();
        let attacks = offered
            .view
            .you
            .battlefield
            .iter()
            .filter(|c| c.name.ends_with("Scout"))
            .map(|c| PlaytestAttackPair {
                attacker: c.id,
                target: None,
                player: None,
            })
            .collect();
        let asked = game.act(A::Attack { attacks }).unwrap();
        let answered = game.act(A::Choose { index: 0 }).unwrap();
        (asked, answered)
    });
    assert_eq!(asked.view.stage, Stage::Prompt, "{:?}", asked.happened);
    let prompt = asked.view.prompt.unwrap();
    assert_eq!(prompt.kind, "OrderTriggers");
    assert_eq!(prompt.options.len(), 2, "two triggers have two orders");
    for option in &prompt.options {
        let mut names: Vec<&str> = option.cards.iter().map(|c| c.name.as_str()).collect();
        names.sort_unstable();
        assert_eq!(names, ["Dawn Scout", "Dusk Scout"], "{option:?}");
        assert!(option.cards.iter().all(|c| c.card_id.is_some()));
        assert!(
            option.cards.iter().all(|c| c.text.is_some()),
            "each trigger carries its words: {option:?}"
        );
        assert_eq!(option.number, None, "an order is its cards, not a number");
    }
    assert_ne!(
        prompt.options[0].cards[0].id, prompt.options[1].cards[0].id,
        "the two answers are the two orders"
    );
    assert_ne!(answered.view.stage, Stage::Prompt);
}

/// Issue #1022: undo takes back the reader's last action and everything the AI did after it,
/// back to the reader's last decision; redo comes forward to exactly the same table.
#[test]
fn undo_goes_back_to_the_readers_last_decision_and_redo_returns() {
    engine(|| {
        let (mut game, _) = kept(2);
        let main = game.view();
        assert_eq!(main.stage, Stage::Main);
        assert!(main.can_undo, "the keep can be undone");

        let after = to_main(&mut game).view;
        assert!(after.turn > main.turn, "the AI played a turn");

        // `to_main` may have stopped more than once; undo each of the reader's decisions.
        while game.view().turn != main.turn || game.view().stage != Stage::Main {
            let step = game.act(A::Undo).unwrap();
            assert!(step.happened.is_empty() && step.frames.is_empty());
        }
        let back = game.view();
        assert_eq!(back.you.hand, main.you.hand);
        assert_eq!(back.opponents, main.opponents);
        assert!(back.can_redo);

        while game.view().can_redo {
            game.act(A::Redo).unwrap();
        }
        let again = game.view();
        assert_eq!(again.turn, after.turn);
        assert_eq!(again.you.hand, after.you.hand);
        assert_eq!(again.opponents, after.opponents);
        assert_eq!(again.you.life, after.you.life);
    });
}

/// The stops are a setting, not a move: setting them is not undone, and undo leaves them be.
#[test]
fn the_stops_are_not_undone() {
    engine(|| {
        let (mut game, _) = kept(2);
        game.act(A::Undo).unwrap();
        assert!(!game.view().can_undo);
        let stops = vec![PlaytestStop {
            seat: Seat::Opponent,
            step: PlaytestStopStep::Upkeep,
        }];
        let set = game
            .act(A::SetStops {
                stops: stops.clone(),
            })
            .unwrap()
            .view;
        assert!(!set.can_undo, "a setting is not an action to undo");
        assert!(set.can_redo, "and does not end the redo trail");
        game.act(A::Redo).unwrap();
        game.act(A::Undo).unwrap();
        assert_eq!(game.view().stops, stops);
    });
}

/// Issue #1022: undo walks back through the turn's phases one decision at a time — the second
/// main phase, combat, the first main phase, the previous turn — each exactly as it stood.
#[test]
fn undo_walks_back_through_the_phases_one_decision_at_a_time() {
    engine(|| {
        let (mut game, _) = kept(2);
        put_down(&mut game, "Grizzly Bears");
        game.act(A::EndTurn).unwrap();
        // The reader's second turn: main 1, then combat, then on to the end of the turn.
        let mut seen = vec![game.view()];
        assert_eq!(seen[0].phase, PlaytestPhase::Main1);
        let offered = game.act(A::Pass).unwrap().view;
        assert_eq!(offered.stage, Stage::Attack);
        seen.push(offered.clone());
        let attacks = offered
            .attack
            .as_ref()
            .unwrap()
            .attackers
            .iter()
            .map(|a| PlaytestAttackPair {
                attacker: a.id,
                target: None,
                player: None,
            })
            .collect();
        seen.push(game.act(A::Attack { attacks }).unwrap().view);
        for _ in 0..20 {
            let now = seen.last().unwrap();
            if now.turn != seen[0].turn || now.stage == Stage::Over || seen.len() > 8 {
                break;
            }
            let action = match now.stage {
                Stage::Attack => A::Attack { attacks: vec![] },
                Stage::Block => A::Block { blocks: vec![] },
                Stage::Prompt => A::Auto,
                _ => A::Pass,
            };
            seen.push(game.act(action).unwrap().view);
        }
        assert!(seen.len() >= 4, "main 1, combat and past it");

        // Back, one decision at a time: every phase is the one it was, with the same table.
        for then in seen.iter().rev().skip(1) {
            let back = game.act(A::Undo).unwrap().view;
            assert_eq!(
                (back.stage, back.phase, back.step, back.turn, back.active),
                (then.stage, then.phase, then.step, then.turn, then.active)
            );
            assert_eq!(back.you, then.you);
            assert_eq!(back.opponents, then.opponents);
            assert_eq!(back.combat, then.combat);
        }
        // And forward again to where the turn had got to.
        while game.view().can_redo {
            game.act(A::Redo).unwrap();
        }
        let end = seen.last().unwrap();
        let again = game.view();
        assert_eq!(
            (again.stage, again.phase, again.turn, again.active),
            (end.stage, end.phase, end.turn, end.active)
        );
        assert_eq!(again.you, end.you);
    });
}

/// Issue #1076: one ability's two triggers at once — a Herald seeing two creatures attack — are
/// told apart by what set each off: each target question names its trigger's words and its
/// attacker, and the trigger on the stack carries both too.
#[test]
fn one_abilitys_two_triggers_carry_what_set_each_off() {
    let (first, second) = engine(|| {
        let mut deck = green();
        deck.push(card(
            "Herald of Dawn",
            Some("{G}"),
            "Creature — Elf",
            "Whenever a creature you control attacks, it deals 1 damage to any target.",
            Some(("0", "1")),
            "G",
            4,
        ));
        for name in ["Dawn Bear", "Dusk Bear"] {
            deck.push(card(
                name,
                Some("{G}"),
                "Creature — Bear",
                "",
                Some(("2", "2")),
                "G",
                4,
            ));
        }
        let (mut game, _) = deal(deck, 2);
        game.act(A::Keep { bottom: vec![] }).unwrap();
        put_down(&mut game, "Herald of Dawn");
        put_down(&mut game, "Dawn Bear");
        put_down(&mut game, "Dusk Bear");
        to_main(&mut game);
        let offered = game.act(A::Pass).unwrap();
        let attacks = offered
            .view
            .you
            .battlefield
            .iter()
            .filter(|c| c.name.ends_with("Bear"))
            .map(|c| PlaytestAttackPair {
                attacker: c.id,
                target: None,
                player: None,
            })
            .collect();
        let first = game.act(A::Attack { attacks }).unwrap();
        // Each trigger asks for its target in turn; the opponent is one answer to either.
        let at_them = |step: &PlaytestStep| {
            let prompt = step.view.prompt.as_ref().expect("a target is asked for");
            prompt
                .options
                .iter()
                .find(|o| o.players == [AI_SEAT])
                .map(|o| o.index)
                .expect("the opponent is a target")
        };
        let index = at_them(&first);
        let second = game.act(A::Choose { index }).unwrap();
        (first, second)
    });
    let cause_of = |step: &PlaytestStep| {
        let prompt = step.view.prompt.as_ref().expect("a target is asked for");
        assert_eq!(prompt.kind, "TriggerTargetSelection", "{prompt:?}");
        assert_eq!(prompt.source.as_deref(), Some("Herald of Dawn"));
        assert!(
            prompt
                .source_text
                .as_deref()
                .is_some_and(|t| t.contains("damage")),
            "the question names its trigger's words: {prompt:?}"
        );
        let cause = prompt.cause.as_ref().expect("the question names its cause");
        assert_eq!(cause.player, Some(PlaytestPlayer::You));
        cause.name.clone().expect("the attacker is on the table")
    };
    let mut causes = [cause_of(&first), cause_of(&second)];
    causes.sort_unstable();
    assert_eq!(
        causes,
        ["Dawn Bear", "Dusk Bear"],
        "one trigger for each attacker"
    );
    let herald = second
        .view
        .stack
        .iter()
        .find(|item| item.name == "Herald of Dawn")
        .expect("the first trigger waits on the stack");
    assert!(herald.ability && herald.text.as_deref().is_some_and(|t| t.contains("damage")));
    assert!(
        herald.cause.as_ref().is_some_and(|c| c.name.is_some()),
        "the trigger on the stack names its attacker: {herald:?}"
    );
}
