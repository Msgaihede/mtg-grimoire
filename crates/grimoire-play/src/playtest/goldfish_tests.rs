//! The game against the goldfish, end to end on a small Commander deck, every test on the
//! engine's stack: what used to be the goldfish board's own session, now the one game with the
//! goldfish across the table and the sandbox on (the owner's decision of 2026-10-17).

use crate::cards::{CardFacts, FaceFacts};
use crate::on_engine_stack;
use crate::view::{GameCard, Lane, ManaByType, Place};

use super::session::Playtest;
use super::view::{
    Difficulty, PlaytestAction as A, PlaytestAttackPair, PlaytestHappened as H,
    PlaytestPickPurpose, PlaytestPlayer, PlaytestStage as Stage, PlaytestStep, PlaytestView,
};

const YOU: PlaytestPlayer = PlaytestPlayer::You;
const FISH: PlaytestPlayer = PlaytestPlayer::Opponent;

fn card(
    name: &str,
    cost: Option<&str>,
    type_line: &str,
    text: &str,
    pt: Option<(&str, &str)>,
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
            vec!["G".into()]
        } else {
            vec![]
        },
        color_identity: vec!["G".into()],
        ..CardFacts::default()
    }
}

fn deck() -> Vec<CardFacts> {
    let mut fynn = card(
        "Fynn, the Fangbearer",
        Some("{1}{G}"),
        "Legendary Creature — Human Warrior",
        "Deathtouch\nWhenever a creature you control with deathtouch deals combat damage to a player, that player gets two poison counters.",
        Some(("1", "3")),
        1,
    );
    fynn.commander = true;
    fynn.keywords = vec!["Deathtouch".into()];
    vec![
        fynn,
        card(
            "Forest",
            None,
            "Basic Land — Forest",
            "({T}: Add {G}.)",
            None,
            60,
        ),
        card(
            "Llanowar Elves",
            Some("{G}"),
            "Creature — Elf Druid",
            "{T}: Add {G}.",
            Some(("1", "1")),
            13,
        ),
        card(
            "Grizzly Bears",
            Some("{1}{G}"),
            "Creature — Bear",
            "",
            Some(("2", "2")),
            13,
        ),
        card(
            "Giant Growth",
            Some("{G}"),
            "Instant",
            "Target creature gets +3/+3 until end of turn.",
            None,
            12,
        ),
    ]
}

/// A game of `cards` against the goldfish, at the opening hand.
fn fish(cards: &[CardFacts], seed: u64) -> (Playtest, PlaytestStep) {
    Playtest::new(cards, &[], &[], seed, Difficulty::default()).expect("a game starts")
}

/// A game past its opening hand, kept at seven, at the reader's first main phase.
fn kept() -> Playtest {
    let (mut game, _) = fish(&deck(), 7);
    game.act(A::Keep { bottom: vec![] }).expect("keep seven");
    game
}

fn find<'a>(cards: &'a [GameCard], name: &str) -> Option<&'a GameCard> {
    cards.iter().find(|c| c.name == name)
}

/// Draw until the hand holds `name`, so a test does not depend on the shuffle.
fn in_hand(game: &mut Playtest, name: &str) -> u64 {
    for _ in 0..80 {
        if let Some(c) = find(&game.view().you.hand, name) {
            return c.id;
        }
        game.act(A::Draw { count: 1 }).expect("draw");
    }
    panic!("never drew {name}");
}

/// Put a card from the hand onto the battlefield by hand, and its id there.
fn put_down(game: &mut Playtest, name: &str) -> u64 {
    let id = in_hand(game, name);
    let step = game
        .act(A::Move {
            id,
            to: Place::Battlefield,
        })
        .expect("put down");
    step.view
        .you
        .battlefield
        .iter()
        .rev()
        .find(|c| c.name == name)
        .expect("on the battlefield")
        .id
}

fn engine<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> T {
    on_engine_stack(work).expect("the engine ran")
}

#[test]
fn a_new_game_waits_on_the_opening_hand_with_the_commander_in_the_command_zone() {
    let view: PlaytestView = engine(|| fish(&deck(), 7).1.view);
    assert_eq!(view.stage, Stage::Mulligan);
    assert!(
        view.goldfish && view.sandbox,
        "the goldfish, with the sandbox on"
    );
    assert_eq!(view.turn, 0);
    assert_eq!(view.started, YOU, "the reader is always on the play");
    assert_eq!(view.you.hand.len(), 7);
    assert_eq!(
        view.you.library,
        98 - 7,
        "98 in the library, the commander beside it"
    );
    assert_eq!(view.you.life, 40);
    let mulligan = view.mulligan.expect("the mulligan is offered");
    assert_eq!((mulligan.mulligans, mulligan.bottom), (0, 0));
    assert!(mulligan.free_first, "Commander's first mulligan is free");
    assert_eq!(view.you.command.len(), 1);
    assert_eq!(view.you.command[0].name, "Fynn, the Fangbearer");
    assert!(view.you.command[0].is_commander);
    assert_eq!(
        view.you.command[0].card_id.as_deref(),
        Some("print-fynn--the-fangbearer")
    );
    assert!(
        view.you.hand.iter().all(|c| c.card_id.is_some()),
        "every card has a printing"
    );
    let lands = view.you.library_cards.iter().filter(|c| c.is_land).count()
        + view.you.hand.iter().filter(|c| c.is_land).count();
    assert_eq!(lands, 60);

    // The goldfish: one seat, 40 life, seven cards kept from a library of lands, and nothing
    // to show — its rules emblems are never in its command zone.
    assert_eq!(view.opponents.len(), 1);
    let goldfish = &view.opponents[0];
    assert_eq!(goldfish.player, FISH);
    assert_eq!(goldfish.life, 40);
    assert_eq!(goldfish.hand_count, 7);
    assert_eq!(goldfish.library, 193);
    assert!(goldfish.hand.is_empty() && goldfish.library_cards.is_empty());
    assert!(goldfish.command.is_empty() && goldfish.battlefield.is_empty());
    assert_eq!(goldfish.dead_on, None);
}

#[test]
fn the_london_mulligan_bottoms_one_fewer_card_when_the_first_is_free() {
    let (first, second, kept) = engine(|| {
        let (mut game, _) = fish(&deck(), 7);
        let first = game.act(A::Mulligan).unwrap();
        let second = game.act(A::Mulligan).unwrap();
        let bottom = vec![second.view.you.hand[0].id];
        let refused = game.act(A::Keep { bottom: vec![] });
        assert!(
            refused.is_err(),
            "keeping without picking the bottom card is refused"
        );
        let kept = game.act(A::Keep { bottom }).unwrap();
        (first, second, kept)
    });
    let m1 = first.view.mulligan.unwrap();
    assert_eq!((m1.mulligans, m1.bottom), (1, 0));
    assert_eq!(first.view.you.hand.len(), 7);
    let m2 = second.view.mulligan.unwrap();
    assert_eq!((m2.mulligans, m2.bottom), (2, 1));
    assert_eq!(kept.view.stage, Stage::Main);
    assert_eq!(kept.view.turn, 1);
    assert_eq!(
        kept.view.you.hand.len(),
        6,
        "the player on the play does not draw on turn 1"
    );
    assert!(kept.happened.contains(&H::Kept {
        size: 6,
        bottomed: 1
    }));
    assert!(kept.happened.contains(&H::TurnBegan { turn: 1, seat: YOU }));
}

#[test]
fn a_land_is_played_by_the_land_drop_and_a_second_is_put_by_hand() {
    let (first, second) = engine(|| {
        let mut game = kept();
        let a = in_hand(&mut game, "Forest");
        let first = game.act(A::Play { id: a }).unwrap();
        let b = in_hand(&mut game, "Forest");
        let second = game.act(A::Play { id: b }).unwrap();
        (first, second)
    });
    assert!(first.happened.contains(&H::Played {
        seat: YOU,
        name: "Forest".into()
    }));
    assert_eq!(first.view.you.mana_open, 1);
    let forest = find(&first.view.you.battlefield, "Forest").unwrap();
    assert_eq!(forest.lane, Lane::Land);
    assert_eq!(
        forest.card_id.as_deref(),
        Some("print-forest"),
        "the printing follows the card"
    );
    assert!(second.happened.contains(&H::Put {
        seat: YOU,
        name: "Forest".into(),
        from: Place::Hand,
        to: Place::Battlefield,
    }));
    assert_eq!(second.view.you.mana_open, 2);
}

#[test]
fn a_spell_is_cast_from_untapped_mana_and_cast_unpaid_without_it() {
    let (cast, unpaid) = engine(|| {
        let mut game = kept();
        let forest = in_hand(&mut game, "Forest");
        game.act(A::Play { id: forest }).unwrap();
        let elf = in_hand(&mut game, "Llanowar Elves");
        let cast = game.act(A::Play { id: elf }).unwrap();
        let bear = in_hand(&mut game, "Grizzly Bears");
        let unpaid = game.act(A::Play { id: bear }).unwrap();
        (cast, unpaid)
    });
    assert!(
        cast.happened.contains(&H::Cast {
            seat: YOU,
            name: Some("Llanowar Elves".into()),
        }),
        "{:?}",
        cast.happened
    );
    let elf = find(&cast.view.you.battlefield, "Llanowar Elves").unwrap();
    assert_eq!(elf.lane, Lane::Creature);
    assert_eq!((elf.power, elf.toughness), (Some(1), Some(1)));
    assert!(
        find(&cast.view.you.battlefield, "Forest").unwrap().tapped,
        "the cast tapped the Forest"
    );
    assert_eq!(
        cast.view.you.mana_open, 0,
        "a summoning-sick elf makes no mana"
    );
    assert!(
        unpaid.happened.contains(&H::Cast {
            seat: YOU,
            name: Some("Grizzly Bears".into()),
        }),
        "cast without paying (CR 118.9): {:?}",
        unpaid.happened
    );
    assert!(find(&unpaid.view.you.battlefield, "Grizzly Bears").is_some());
}

/// "Next turn" is the playtest's `endTurn` now: the goldfish's turn passes doing nothing — it
/// draws and keeps the card, with no maximum hand size — and the reader's untaps and draws.
#[test]
fn ending_the_turn_plays_the_goldfishs_turn_and_untaps_and_draws() {
    let next = engine(|| {
        let mut game = kept();
        let forest = in_hand(&mut game, "Forest");
        game.act(A::Play { id: forest }).unwrap();
        let id = game.view().you.battlefield[0].id;
        game.act(A::Tap {
            ids: vec![id],
            tapped: true,
        })
        .unwrap();
        let hand = game.view().you.hand.len();
        let next = game.act(A::EndTurn).unwrap();
        assert_eq!(next.view.you.hand.len(), hand + 1, "drew for the turn");
        next
    });
    assert_eq!(next.view.stage, Stage::Main);
    assert_eq!(
        next.view.turn, 3,
        "the game's turns: the goldfish's was the second"
    );
    assert_eq!(next.view.active, YOU);
    assert!(
        next.view.you.battlefield.iter().all(|c| !c.tapped),
        "untapped"
    );
    let goldfish = &next.view.opponents[0];
    assert_eq!(goldfish.hand_count, 8, "it drew its eighth and kept it");
    assert!(goldfish.graveyard.is_empty(), "and discarded nothing");
    assert_eq!(goldfish.life, 40);
    let theirs = next
        .happened
        .iter()
        .position(|h| {
            *h == H::TurnBegan {
                turn: 2,
                seat: FISH,
            }
        })
        .expect("the goldfish's turn is told");
    let yours = next
        .happened
        .iter()
        .position(|h| *h == H::TurnBegan { turn: 3, seat: YOU })
        .expect("the reader's turn is told");
    assert!(theirs < yours, "{:?}", next.happened);
    assert!(next.happened.contains(&H::Drew {
        seat: FISH,
        name: None
    }));
    assert!(next.happened.iter().any(|h| matches!(
        h,
        H::Drew {
            seat: YOU,
            name: Some(_)
        }
    )));
}

/// The goldfish never blocks: a creature attacks it, and its life drops by the rules.
#[test]
fn a_creature_attacks_the_goldfish_and_its_life_drops() {
    let (asked, hit) = engine(|| {
        let mut game = kept();
        let bear = put_down(&mut game, "Grizzly Bears");
        game.act(A::EndTurn).unwrap();
        // The bear has been under the reader's control since their last turn began.
        let bear = find(&game.view().you.battlefield, "Grizzly Bears").map_or(bear, |c| c.id);
        let asked = game.act(A::Pass).unwrap();
        let hit = game
            .act(A::Attack {
                attacks: vec![PlaytestAttackPair {
                    attacker: bear,
                    target: None,
                    player: None,
                }],
            })
            .unwrap();
        (asked, hit)
    });
    assert_eq!(asked.view.stage, Stage::Attack);
    assert_eq!(hit.view.stage, Stage::Main, "on to the second main phase");
    assert_eq!(hit.view.opponents[0].life, 38);
    assert!(hit.happened.contains(&H::Life {
        seat: FISH,
        amount: -2,
        total: 38
    }));
    assert!(!hit.happened.iter().any(|h| matches!(h, H::Blocked { .. })));
}

/// The cleanup step's discard is the reader's to choose, as the playtest asks it: a pick.
#[test]
fn a_turn_passed_over_the_hand_size_asks_the_reader_which_cards_to_discard() {
    let (asked, refused, short, done, chosen) = engine(|| {
        let mut game = kept();
        let short_of_ten = 10 - game.view().you.hand.len() as u32;
        game.act(A::Draw {
            count: short_of_ten,
        })
        .unwrap();
        let asked = game.act(A::EndTurn).unwrap();
        let refused = game.act(A::Draw { count: 1 }).unwrap_err();
        // The oldest three, never the newest: what the engine's own first answer would not be.
        let chosen: Vec<(u64, String)> = asked.view.you.hand[..3]
            .iter()
            .map(|c| (c.id, c.name.clone()))
            .collect();
        let short = game
            .act(A::PickCards {
                ids: vec![chosen[0].0],
            })
            .unwrap_err();
        assert_eq!(game.view(), asked.view, "a refusal changed nothing");
        let done = game
            .act(A::PickCards {
                ids: chosen.iter().map(|c| c.0).collect(),
            })
            .unwrap();
        (asked, refused, short, done, chosen)
    });
    assert_eq!(asked.view.stage, Stage::Prompt);
    let pick = asked.view.prompt.as_ref().unwrap().pick.as_ref().unwrap();
    assert_eq!(pick.purpose, PlaytestPickPurpose::Discard);
    assert_eq!((pick.min, pick.max), (3, 3));
    assert_eq!(asked.view.turn, 1, "the turn has not passed yet");
    assert_eq!(
        asked.view.you.hand.len(),
        10,
        "nothing was discarded for them"
    );
    assert!(asked.view.you.graveyard.is_empty());
    assert!(!asked.happened.iter().any(|h| matches!(h, H::Chose { .. })));
    assert!(refused.contains("Answer the question first"), "{refused}");
    assert_eq!(short, "Pick 3 cards.");

    assert_eq!(done.view.stage, Stage::Main);
    assert_eq!(done.view.turn, 3);
    assert_eq!(
        done.view.you.hand.len(),
        8,
        "seven kept, and the turn's draw"
    );
    let mut buried: Vec<&str> = done
        .view
        .you
        .graveyard
        .iter()
        .map(|c| c.name.as_str())
        .collect();
    let mut names: Vec<&str> = chosen.iter().map(|c| c.1.as_str()).collect();
    buried.sort_unstable();
    names.sort_unstable();
    assert_eq!(buried, names, "the cards the reader chose, and no others");
    let discarded = done
        .happened
        .iter()
        .filter(|h| {
            matches!(
                h,
                H::Moved {
                    seat: YOU,
                    from: Place::Hand,
                    to: Place::Graveyard,
                    ..
                }
            )
        })
        .count();
    assert_eq!(discarded, 3);
    assert!(done.happened.contains(&H::TurnBegan { turn: 3, seat: YOU }));
}

/// "Choose creatures with total power 4 or less, sacrifice the rest" is the reader's to choose,
/// as a pick of their creatures under the cap (issue #1079): a set over the cap is refused, and
/// the creatures left out are sacrificed. The engine's own canned answers name what they keep.
#[test]
fn a_keep_within_total_power_asks_which_creatures_to_keep() {
    let (asked, over, done, kept_ids) = engine(|| {
        let mut cards = deck();
        cards.push(card(
            "Destined Confrontation",
            Some("{G}"),
            "Sorcery",
            "Each player chooses any number of creatures they control with total power 4 or less, then sacrifices all other creatures they control.",
            None,
            10,
        ));
        let (mut game, _) = fish(&cards, 7);
        game.act(A::Keep { bottom: vec![] }).unwrap();
        let forest = in_hand(&mut game, "Forest");
        game.act(A::Play { id: forest }).unwrap();
        let bears: Vec<u64> = (0..3)
            .map(|_| put_down(&mut game, "Grizzly Bears"))
            .collect();
        let elf = put_down(&mut game, "Llanowar Elves");
        let spell = in_hand(&mut game, "Destined Confrontation");
        let asked = game.act(A::Play { id: spell }).unwrap();
        let over = game.act(A::PickCards { ids: bears.clone() }).unwrap_err();
        assert_eq!(game.view(), asked.view, "a refusal changed nothing");
        let kept_ids = vec![bears[0], elf];
        let done = game
            .act(A::PickCards {
                ids: kept_ids.clone(),
            })
            .unwrap();
        (asked, over, done, kept_ids)
    });
    assert_eq!(asked.view.stage, Stage::Prompt, "{:?}", asked.happened);
    let prompt = asked.view.prompt.as_ref().unwrap();
    assert_eq!(prompt.kind, "KeepWithinTotalPowerChoice");
    let pick = prompt.pick.as_ref().expect("asked as a pick");
    assert_eq!(pick.purpose, PlaytestPickPurpose::Keep);
    assert_eq!(pick.power_cap, Some(4));
    assert_eq!((pick.min, pick.max), (0, 4));
    assert_eq!(pick.eligible.len(), 4, "every creature the reader controls");
    assert!(
        prompt
            .options
            .iter()
            .filter(|o| o.kind == "ChooseKeptCreatures")
            .any(|o| !o.cards.is_empty()),
        "the engine's answers name the creatures they keep: {:?}",
        prompt.options
    );
    assert_eq!(
        over,
        "The kept creatures' total power is 6; it may be at most 4."
    );

    assert_eq!(done.view.stage, Stage::Main, "{:?}", done.happened);
    let mut left: Vec<u64> = done
        .view
        .you
        .battlefield
        .iter()
        .filter(|c| c.power.is_some())
        .map(|c| c.id)
        .collect();
    left.sort_unstable();
    let mut kept_ids = kept_ids;
    kept_ids.sort_unstable();
    assert_eq!(
        left, kept_ids,
        "the creatures the reader kept, and no others"
    );
    let buried = done
        .view
        .you
        .graveyard
        .iter()
        .filter(|c| c.name == "Grizzly Bears")
        .count();
    assert_eq!(buried, 2, "the bears left out were sacrificed");
}

/// Neither seat loses: the goldfish at 0 life is "dead on your turn 1", and the game goes on.
#[test]
fn a_life_total_at_zero_does_not_end_the_game() {
    let (dead, later, alive) = engine(|| {
        let mut game = kept();
        let dead = game
            .act(A::SetLife {
                seat: FISH,
                life: 0,
            })
            .unwrap();
        assert!(dead.happened.contains(&H::LifeSet {
            seat: FISH,
            life: 0,
            was: 40
        }));
        game.act(A::SetLife {
            seat: YOU,
            life: -3,
        })
        .unwrap();
        let later = game.act(A::EndTurn).unwrap().view;
        let alive = game
            .act(A::SetLife {
                seat: FISH,
                life: 5,
            })
            .unwrap()
            .view;
        (dead.view, later, alive)
    });
    assert_eq!(dead.stage, Stage::Main);
    assert_eq!(dead.opponents[0].dead_on, Some(1));
    assert_eq!(later.stage, Stage::Main, "never over");
    assert_eq!(later.opponents[0].life, 0);
    assert_eq!(later.you.life, -3);
    assert_eq!(later.turn, 3);
    assert_eq!(
        later.opponents[0].dead_on,
        Some(1),
        "the turn it died on, not the turn it is"
    );
    assert!(!later.you.out && !later.opponents[0].out);
    assert_eq!(alive.opponents[0].dead_on, None, "back above 0");
}

#[test]
fn the_commander_cast_unpaid_still_raises_its_tax() {
    let (on_field, back) = engine(|| {
        let mut game = kept();
        let fynn = game.view().you.command[0].id;
        let on_field = game.act(A::Play { id: fynn }).unwrap();
        let id = find(&on_field.view.you.battlefield, "Fynn, the Fangbearer")
            .unwrap()
            .id;
        let back = game
            .act(A::Move {
                id,
                to: Place::Command,
            })
            .unwrap();
        (on_field, back)
    });
    let fynn = find(&on_field.view.you.battlefield, "Fynn, the Fangbearer").unwrap();
    assert_eq!(fynn.card_id.as_deref(), Some("print-fynn--the-fangbearer"));
    assert_eq!(back.view.you.command.len(), 1);
    assert_eq!(back.view.you.command[0].tax, 2);
}

#[test]
fn counters_change_power_and_toughness() {
    let creature = engine(|| {
        let mut game = kept();
        let id = put_down(&mut game, "Grizzly Bears");
        game.act(A::Counters {
            id,
            kind: "+1/+1".into(),
            delta: 2,
        })
        .unwrap();
        find(&game.view().you.battlefield, "Grizzly Bears")
            .unwrap()
            .clone()
    });
    assert_eq!((creature.power, creature.toughness), (Some(4), Some(4)));
    // The printed P/T stays beside it, for the board's changed-stats chip (issue #1332).
    assert_eq!(
        (creature.base_power, creature.base_toughness),
        (Some(2), Some(2))
    );
    assert_eq!(creature.counters.len(), 1);
    assert_eq!(creature.counters[0].count, 2);
    assert_eq!(creature.counters[0].kind, "+1/+1");
}

/// Issue #1332: a `*/*` creature's base is what its own ability makes it, not phase's printed 0,
/// so the board does not mark one at its own count as pumped.
#[test]
fn a_star_creatures_base_is_its_own_count() {
    let elder = engine(|| {
        let mut cards = deck();
        let bears = cards
            .iter_mut()
            .find(|c| c.name == "Grizzly Bears")
            .unwrap();
        *bears = card(
            "Dungrove Elder",
            Some("{2}{G}"),
            "Creature — Treefolk",
            "Hexproof\nDungrove Elder's power and toughness are each equal to the number of Forests you control.",
            Some(("*", "*")),
            13,
        );
        let (mut game, _) = fish(&cards, 7);
        game.act(A::Keep { bottom: vec![] }).expect("keep seven");
        put_down(&mut game, "Forest");
        put_down(&mut game, "Forest");
        put_down(&mut game, "Dungrove Elder");
        find(&game.view().you.battlefield, "Dungrove Elder")
            .unwrap()
            .clone()
    });
    assert_eq!((elder.power, elder.toughness), (Some(2), Some(2)));
    assert_eq!((elder.base_power, elder.base_toughness), (Some(2), Some(2)));
}

/// Issue #991: a token the deck keeps is offered and drawn in the printing the reader set for it,
/// not phase's.
#[test]
fn a_card_the_engine_plays_only_in_part_carries_its_gaps_in_hand_and_on_the_battlefield() {
    let mut cards = deck();
    // Rules text no parser has a word for, as `support.rs`' tests use.
    cards.push(card(
        "Moonlit Bard",
        Some("{1}{G}"),
        "Creature — Elf Bard",
        "Whenever the moon is full, sing a song of the old forest to every listener.",
        Some(("2", "2")),
        8,
    ));
    let (hand, battlefield, bears) = engine(move || {
        let (mut game, _) = fish(&cards, 7);
        game.act(A::Keep { bottom: vec![] }).unwrap();
        let id = in_hand(&mut game, "Moonlit Bard");
        let hand = game
            .view()
            .you
            .hand
            .into_iter()
            .find(|c| c.id == id)
            .unwrap();
        put_down(&mut game, "Moonlit Bard");
        put_down(&mut game, "Grizzly Bears");
        let view = game.view();
        let on = |name: &str| find(&view.you.battlefield, name).unwrap().clone();
        (hand, on("Moonlit Bard"), on("Grizzly Bears"))
    });
    assert!(!hand.gaps.is_empty(), "in hand: {hand:?}");
    assert_eq!(battlefield.gaps, hand.gaps, "the same face, the same gaps");
    assert!(bears.gaps.is_empty(), "a card played in full has none");
}

#[test]
fn a_token_is_offered_and_drawn_in_the_printing_the_deck_sets() {
    let (preset, oracle, source) = crate::tokens::a_treasure();
    let token = crate::tokens::a_treasure_facts(&oracle, &source);
    let mut cards = deck();
    cards.push(card(&source, Some("{1}{G}"), "Enchantment", "", None, 1));
    let view = engine(move || {
        let (mut game, _) = Playtest::new(&cards, &[token], &[], 7, Difficulty::default()).unwrap();
        game.act(A::Keep { bottom: vec![] }).unwrap();
        game.act(A::CreateToken { preset, count: 1 }).unwrap().view
    });
    let offer = view.tokens.iter().find(|t| t.name == "Treasure").unwrap();
    assert_eq!(offer.card_id.as_deref(), Some("deck-treasure"));
    let made = view.you.battlefield.iter().find(|c| c.is_token).unwrap();
    assert_eq!(made.card_id.as_deref(), Some("deck-treasure"));
}

#[test]
fn a_card_goes_to_the_bottom_of_the_library_and_a_token_leaving_play_is_gone() {
    let (library, tokens) = engine(|| {
        let mut game = kept();
        let bear = in_hand(&mut game, "Grizzly Bears");
        let before = game.view().you.library;
        let step = game
            .act(A::Move {
                id: bear,
                to: Place::LibraryBottom,
            })
            .unwrap();
        assert_eq!(step.view.you.library, before + 1);
        assert_eq!(
            step.view.you.library_cards.len() as u32,
            step.view.you.library
        );
        assert_eq!(
            step.view.you.library_cards.last().unwrap().name,
            "Grizzly Bears",
            "the bottom is last"
        );
        let top = step.view.you.library_cards[0].name.clone();
        let drawn = game.act(A::Draw { count: 1 }).unwrap();
        assert_eq!(
            drawn.view.you.hand.last().unwrap().name,
            top,
            "a draw takes the first card"
        );
        let id = put_down(&mut game, "Llanowar Elves");
        let step = game.act(A::TokenCopy { id }).unwrap();
        let copies: Vec<_> = step
            .view
            .you
            .battlefield
            .iter()
            .filter(|c| c.is_token)
            .cloned()
            .collect();
        assert_eq!(copies.len(), 1);
        let gone = game
            .act(A::Move {
                id: copies[0].id,
                to: Place::Graveyard,
            })
            .unwrap();
        (step.view.you.library, gone.view)
    });
    assert!(library > 0);
    assert!(tokens.you.battlefield.iter().all(|c| !c.is_token));
    assert!(tokens.you.graveyard.iter().all(|c| !c.is_token));
}

#[test]
fn an_action_before_the_keep_is_refused_and_changes_nothing() {
    let (refused, hand) = engine(|| {
        let (mut game, _) = fish(&deck(), 7);
        let hand = game.view().you.hand.len();
        (
            game.act(A::EndTurn).unwrap_err(),
            game.view().you.hand.len() == hand,
        )
    });
    assert_eq!(refused, "Keep or mulligan the opening hand first.");
    assert!(hand);
}

#[test]
fn the_same_seed_deals_the_same_hand() {
    let (a, b) = engine(|| (fish(&deck(), 42).1.view, fish(&deck(), 42).1.view));
    let names = |v: &PlaytestView| {
        v.you
            .hand
            .iter()
            .map(|c| c.name.clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(names(&a), names(&b));
}

#[test]
fn a_spell_with_one_target_is_cast_at_it() {
    let step = engine(|| {
        let mut game = kept();
        let forest = in_hand(&mut game, "Forest");
        game.act(A::Play { id: forest }).unwrap();
        put_down(&mut game, "Grizzly Bears");
        let growth = in_hand(&mut game, "Giant Growth");
        game.act(A::Play { id: growth }).unwrap()
    });
    assert!(step.happened.contains(&H::Cast {
        seat: YOU,
        name: Some("Giant Growth".into()),
    }));
    let bear = find(&step.view.you.battlefield, "Grizzly Bears").unwrap();
    assert_eq!((bear.power, bear.toughness), (Some(5), Some(5)));
    assert_eq!((bear.base_power, bear.base_toughness), (Some(2), Some(2)));
    assert!(find(&step.view.you.graveyard, "Giant Growth").is_some());
}

/// A spell with a choice of targets asks, as against the AI — the goldfish board used to put it
/// down unpaid instead — and `cancel` puts the game back as it was.
#[test]
fn a_spell_that_asks_for_a_choice_asks_and_cancel_puts_the_game_back() {
    let (asked, cancelled) = engine(|| {
        let mut game = kept();
        let forest = in_hand(&mut game, "Forest");
        game.act(A::Play { id: forest }).unwrap();
        for _ in 0..2 {
            put_down(&mut game, "Grizzly Bears");
        }
        let growth = in_hand(&mut game, "Giant Growth");
        let asked = game.act(A::Play { id: growth }).unwrap();
        (asked, game.act(A::Cancel).unwrap())
    });
    assert_eq!(asked.view.stage, Stage::Prompt, "{:?}", asked.happened);
    let prompt = asked.view.prompt.as_ref().unwrap();
    assert!(prompt.cancellable);
    assert_eq!(prompt.source.as_deref(), Some("Giant Growth"));
    assert_eq!(cancelled.view.stage, Stage::Main);
    assert!(find(&cancelled.view.you.hand, "Giant Growth").is_some());
    assert!(
        !find(&cancelled.view.you.battlefield, "Forest")
            .unwrap()
            .tapped,
        "the attempt paid nothing"
    );
}

/// A spell with overload asks which cost to pay when both are payable, the question naming the
/// keyword, and its overload cost changes "target" to "each" (issue #1072).
#[test]
fn a_spell_with_overload_asks_which_cost_and_its_overload_hits_each() {
    let (asked, cast) = engine(|| {
        let mut cards = deck();
        let mut swell = card(
            "Wild Swell",
            Some("{G}"),
            "Instant",
            "Target creature you control gets +2/+2 until end of turn.\nOverload {2}{G}{G} (You may \
             cast this spell for its overload cost. If you do, change its text by replacing all \
             instances of \"target\" with \"each.\")",
            None,
            1,
        );
        swell.keywords = vec!["Overload".into()];
        cards.push(swell);
        let (mut game, _) = fish(&cards, 7);
        game.act(A::Keep { bottom: vec![] }).expect("keep seven");
        for _ in 0..4 {
            put_down(&mut game, "Forest");
        }
        for _ in 0..2 {
            put_down(&mut game, "Grizzly Bears");
        }
        let swell = in_hand(&mut game, "Wild Swell");
        let asked = game.act(A::Play { id: swell }).unwrap();
        let prompt = asked.view.prompt.clone().expect("a question");
        let overload = prompt
            .options
            .iter()
            .find(|o| o.label.as_deref() == Some("Alternative"))
            .expect("an alternative-cost answer")
            .index;
        (asked, game.act(A::Choose { index: overload }).unwrap())
    });
    assert_eq!(asked.view.stage, Stage::Prompt, "{:?}", asked.happened);
    let prompt = asked.view.prompt.as_ref().unwrap();
    assert_eq!(prompt.kind, "AlternativeCastChoice");
    assert_eq!(prompt.keyword.as_deref(), Some("Overload"));
    assert_eq!(prompt.source.as_deref(), Some("Wild Swell"));
    let mut labels: Vec<_> = prompt.options.iter().map(|o| o.label.as_deref()).collect();
    labels.sort();
    assert_eq!(labels, [Some("Alternative"), Some("Normal")]);
    let bears: Vec<_> = cast
        .view
        .you
        .battlefield
        .iter()
        .filter(|c| c.name == "Grizzly Bears")
        .map(|c| (c.power, c.toughness))
        .collect();
    assert_eq!(bears, [(Some(4), Some(4)); 2], "{:?}", cast.happened);
    assert!(find(&cast.view.you.graveyard, "Wild Swell").is_some());
}

#[test]
fn a_modal_double_faced_card_is_played_by_its_front_face() {
    let view = engine(|| {
        let mut cards = deck();
        cards.push(CardFacts {
            card_id: "print-bala-ged".into(),
            name: "Bala Ged Recovery // Bala Ged Sanctuary".into(),
            quantity: 1,
            type_line: Some("Sorcery // Land".into()),
            layout: Some("modal_dfc".into()),
            cmc: Some(3.0),
            faces: vec![
                FaceFacts {
                    name: "Bala Ged Recovery".into(),
                    mana_cost: Some("{2}{G}".into()),
                    type_line: Some("Sorcery".into()),
                    oracle_text: Some("Return target card from your graveyard to your hand.".into()),
                    ..FaceFacts::default()
                },
                FaceFacts {
                    name: "Bala Ged Sanctuary".into(),
                    mana_cost: Some(String::new()),
                    type_line: Some("Land".into()),
                    oracle_text: Some("As Bala Ged Sanctuary enters, you may pay 3 life. If you don't, it enters tapped.\n{T}: Add {G}.".into()),
                    ..FaceFacts::default()
                },
            ],
            ..CardFacts::default()
        });
        let (mut game, _) = fish(&cards, 7);
        game.act(A::Keep { bottom: vec![] }).unwrap();
        let id = in_hand(&mut game, "Bala Ged Recovery");
        let card = find(&game.view().you.hand, "Bala Ged Recovery")
            .unwrap()
            .clone();
        assert_eq!(card.card_id.as_deref(), Some("print-bala-ged"));
        game.act(A::Move {
            id,
            to: Place::Graveyard,
        })
        .unwrap()
        .view
    });
    assert!(find(&view.you.graveyard, "Bala Ged Recovery").is_some());
}

#[test]
fn the_mana_table_counts_each_type_the_open_sources_could_make() {
    let land =
        |name: &str, type_line: &str, text: &str| card(name, None, type_line, text, None, 20);
    let deck = vec![
        land("Forest", "Basic Land — Forest", "({T}: Add {G}.)"),
        land("Island", "Basic Land — Island", "({T}: Add {U}.)"),
        land("Savannah", "Land", "{T}: Add {G} or {W}."),
        card(
            "Sol Ring",
            Some("{1}"),
            "Artifact",
            "{T}: Add {C}{C}.",
            None,
            20,
        ),
    ];
    let (open, tapped) = engine(move || {
        let (mut game, _) = fish(&deck, 7);
        game.act(A::Keep { bottom: vec![] }).expect("keep seven");
        for name in ["Forest", "Island", "Savannah", "Sol Ring"] {
            put_down(&mut game, name);
        }
        let open = game.view();
        let ring = find(&open.you.battlefield, "Sol Ring").unwrap().id;
        let tapped = game
            .act(A::Tap {
                ids: vec![ring],
                tapped: true,
            })
            .unwrap()
            .view;
        (open, tapped)
    });
    let by_type = |v: &PlaytestView| {
        let m = v.you.mana.open;
        [m.white, m.blue, m.black, m.red, m.green, m.colorless]
    };
    assert_eq!(open.you.mana_open, 5);
    assert_eq!(
        by_type(&open),
        [1, 1, 0, 0, 2, 2],
        "Savannah counts as white and as green; Sol Ring makes two colorless"
    );
    assert_eq!(
        open.you.mana.floating,
        ManaByType::default(),
        "nothing is floating"
    );
    assert_eq!(
        by_type(&tapped),
        [1, 1, 0, 0, 2, 0],
        "a tapped Sol Ring makes none"
    );
}

#[test]
fn a_life_total_the_rules_change_is_told_for_either_seat() {
    let step = engine(|| {
        let mut cards = deck();
        cards.push(card(
            "Fish Feast",
            Some("{G}"),
            "Sorcery",
            "Each opponent loses 2 life and you gain 2 life.",
            None,
            1,
        ));
        let (mut game, _) = fish(&cards, 7);
        game.act(A::Keep { bottom: vec![] }).expect("keep seven");
        let forest = in_hand(&mut game, "Forest");
        game.act(A::Play { id: forest }).unwrap();
        let feast = in_hand(&mut game, "Fish Feast");
        game.act(A::Play { id: feast }).unwrap()
    });
    assert!(
        step.happened.contains(&H::Cast {
            seat: YOU,
            name: Some("Fish Feast".into()),
        }),
        "{:?}",
        step.happened
    );
    assert!(step.happened.contains(&H::Life {
        seat: FISH,
        amount: -2,
        total: 38
    }));
    assert!(step.happened.contains(&H::Life {
        seat: YOU,
        amount: 2,
        total: 42
    }));
    assert_eq!(step.view.opponents[0].life, 38);
}

/// The sandbox is a setting in a goldfish game too: off, the goldfish game is played by the rules
/// alone, and a play they refuse is refused.
#[test]
fn the_sandbox_turned_off_makes_the_goldfish_game_strict() {
    let (off, refused, drawn) = engine(|| {
        let mut game = kept();
        let off = game.act(A::SetSandbox { on: false }).unwrap().view;
        let bear = find(&off.you.hand, "Grizzly Bears").map(|c| c.id);
        let refused = (
            game.act(A::Draw { count: 1 }).unwrap_err(),
            bear.map(|id| game.act(A::Play { id }).unwrap_err()),
        );
        game.act(A::SetSandbox { on: true }).unwrap();
        (off, refused, game.act(A::Draw { count: 1 }).unwrap().view)
    });
    assert!(!off.sandbox && off.goldfish);
    assert!(refused.0.contains("sandbox"), "{}", refused.0);
    if let Some(play) = refused.1 {
        assert!(play.contains("Turn the sandbox on"), "{play}");
    }
    assert_eq!(drawn.you.hand.len(), off.you.hand.len() + 1);
}

/// Issue #1022: undo puts the board back exactly as it was before the action, redo takes it
/// again, and a new action ends the redo trail.
#[test]
fn undo_and_redo_walk_the_board_back_and_forward() {
    engine(|| {
        let (mut game, step) = fish(&deck(), 7);
        let dealt = step.view;
        assert!(
            !dealt.can_undo && !dealt.can_redo,
            "a new game has no history"
        );
        assert_eq!(
            game.act(A::Undo).unwrap_err(),
            "There is nothing to undo.",
            "nothing to undo is a refusal"
        );

        let kept = game.act(A::Keep { bottom: vec![] }).unwrap().view;
        assert!(kept.can_undo && !kept.can_redo);
        let forest = in_hand(&mut game, "Forest");
        let before = game.view();
        let played = game.act(A::Play { id: forest }).unwrap().view;
        assert_eq!(played.you.mana_open, 1);

        let undone = game.act(A::Undo).unwrap();
        assert!(undone.happened.is_empty(), "undo happens nothing");
        let back = undone.view;
        assert_eq!(
            back.you.hand, before.you.hand,
            "the land is back in the hand"
        );
        assert!(back.you.battlefield.is_empty());
        assert!(back.can_redo);

        let redone = game.act(A::Redo).unwrap().view;
        assert_eq!(redone.you.battlefield, played.you.battlefield);
        assert_eq!(redone.you.mana_open, 1);
        assert!(!redone.can_redo);

        // Back to the opening hand, every action at a time: the mulligan is offered again.
        while game.view().can_undo {
            game.act(A::Undo).unwrap();
        }
        let start = game.view();
        assert_eq!(start.stage, Stage::Mulligan);
        assert_eq!(start.you.hand, dealt.you.hand);

        game.act(A::Mulligan).unwrap();
        let view = game.view();
        assert!(!view.can_redo, "a new action ends the redo trail");
        assert_eq!(game.act(A::Redo).unwrap_err(), "There is nothing to redo.");
        assert_eq!(view.mulligan.unwrap().mulligans, 1);
        game.act(A::Undo).unwrap();
        assert_eq!(
            game.view().mulligan.unwrap().mulligans,
            0,
            "the count goes back too"
        );
    });
}

/// The goldfish's `dead_on` is part of the game an undo goes back to.
#[test]
fn undo_takes_back_the_goldfishs_death_too() {
    let (dead, undone) = engine(|| {
        let mut game = kept();
        let dead = game
            .act(A::SetLife {
                seat: FISH,
                life: 0,
            })
            .unwrap()
            .view;
        (dead, game.act(A::Undo).unwrap().view)
    });
    assert_eq!(dead.opponents[0].dead_on, Some(1));
    assert_eq!(undone.opponents[0].dead_on, None);
    assert_eq!(undone.opponents[0].life, 40);
}

/// A refused action is not one to undo: the board was never changed.
#[test]
fn a_refused_action_is_not_remembered() {
    engine(|| {
        let mut game = kept();
        game.act(A::Undo).unwrap();
        assert!(!game.view().can_undo);
        assert!(game.act(A::Play { id: u64::MAX }).is_err());
        assert!(!game.view().can_undo);
        assert!(
            game.view().can_redo,
            "a refusal leaves the redo trail as it was"
        );
    });
}

/// Issue #1143: a refused answer to the board's own question leaves the question open, as the
/// whole moment is put back and not the engine's state alone — the next answer is taken and
/// Cancel still has something to take back.
#[test]
fn a_refused_answer_to_the_boards_question_keeps_it_open() {
    let (refused, asked, after, cancelled) = engine(|| {
        let mut cards = deck();
        cards.push(card(
            "Twin Relic",
            Some("{1}"),
            "Artifact",
            "{1}: You gain 1 life.\n{2}: You gain 2 life.",
            None,
            1,
        ));
        let (mut game, _) = fish(&cards, 7);
        game.act(A::Keep { bottom: vec![] }).expect("keep seven");
        for _ in 0..3 {
            put_down(&mut game, "Forest");
        }
        let relic = put_down(&mut game, "Twin Relic");
        let asked = game.act(A::Activate { id: relic }).unwrap();
        let refused = game.act(A::Choose { index: 99 }).unwrap_err();
        let after = game.view();
        (refused, asked, after, game.act(A::Cancel).unwrap())
    });
    assert_eq!(refused, "That answer is no longer on offer.");
    let prompt = asked.view.prompt.as_ref().expect("a question");
    assert_eq!(prompt.kind, "AbilityChoice", "{:?}", asked.happened);
    assert_eq!(after.stage, Stage::Prompt);
    assert_eq!(
        after.prompt.as_ref(),
        Some(prompt),
        "the same question, still open"
    );
    assert_eq!(cancelled.view.stage, Stage::Main);
    assert!(cancelled.view.prompt.is_none());
}

/// Issue #1075: a card the reader cannot pay for is cast without paying (CR 118.9), not put down,
/// so a trigger that asks whether it was cast — Wakening Sun's Avatar's "if you cast it from your
/// hand" — happens. The free cast's emblem is gone after it: the next spell is paid for.
#[test]
fn a_card_played_unpaid_is_cast_and_its_cast_from_hand_trigger_happens() {
    let (free, paid) = engine(|| {
        let mut cards =
            vec![
            card("Plains", None, "Basic Land — Plains", "({T}: Add {W}.)", None, 40),
            card("Grizzly Bears", Some("{1}{G}"), "Creature — Bear", "", Some(("2", "2")), 20),
            card(
                "Savannah Lions",
                Some("{W}"),
                "Creature — Cat",
                "",
                Some(("2", "1")),
                20,
            ),
            card(
                "Wakening Sun's Avatar",
                Some("{5}{W}{W}{W}"),
                "Creature — Dinosaur Avatar",
                "When Wakening Sun's Avatar enters, if you cast it from your hand, destroy all \
                 non-Dinosaur creatures.",
                Some(("7", "7")),
                20,
            ),
        ];
        for c in &mut cards[2..] {
            c.colors = vec!["W".into()];
        }
        let (mut game, _) = fish(&cards, 7);
        game.act(A::Keep { bottom: vec![] }).unwrap();
        put_down(&mut game, "Grizzly Bears");
        let emblems = game.emblems_for_test();
        let avatar = in_hand(&mut game, "Wakening Sun's Avatar");
        let free = game.act(A::Play { id: avatar }).unwrap();
        assert_eq!(
            game.emblems_for_test(),
            emblems,
            "the free cast's emblem is gone"
        );
        put_down(&mut game, "Plains");
        let lions = in_hand(&mut game, "Savannah Lions");
        (free, game.act(A::Play { id: lions }).unwrap())
    });
    assert!(
        free.happened.contains(&H::Cast {
            seat: YOU,
            name: Some("Wakening Sun's Avatar".into()),
        }),
        "{:?}",
        free.happened
    );
    assert!(find(&free.view.you.battlefield, "Wakening Sun's Avatar").is_some());
    assert!(
        find(&free.view.you.battlefield, "Grizzly Bears").is_none(),
        "the Avatar's trigger destroyed the Bears: {:?}",
        free.happened
    );
    assert!(find(&free.view.you.graveyard, "Grizzly Bears").is_some());
    assert!(paid.happened.contains(&H::Cast {
        seat: YOU,
        name: Some("Savannah Lions".into()),
    }));
    assert!(
        find(&paid.view.you.battlefield, "Plains").unwrap().tapped,
        "the next spell was paid for"
    );
}

/// A free cast that asks a question keeps its emblem while it asks, and Cancel takes the emblem
/// back with the cast: nothing is left that would let the next card be cast free.
#[test]
fn a_free_cast_that_asks_is_cancelled_with_its_emblem() {
    let (emblems, asking, cancelled, step) = engine(|| {
        let mut game = kept();
        for _ in 0..2 {
            put_down(&mut game, "Grizzly Bears");
        }
        let emblems = game.emblems_for_test();
        let growth = in_hand(&mut game, "Giant Growth");
        let step = game.act(A::Play { id: growth }).unwrap();
        let asking = game.emblems_for_test();
        let cancelled = game.act(A::Cancel).unwrap();
        (emblems, asking, game.emblems_for_test(), (step, cancelled))
    });
    let (asked, back) = step;
    assert_eq!(asked.view.stage, Stage::Prompt, "{:?}", asked.happened);
    assert_eq!(
        asking,
        emblems + 1,
        "the emblem is there while the cast asks"
    );
    assert_eq!(cancelled, emblems, "and gone with the cast");
    assert_eq!(back.view.stage, Stage::Main);
    assert!(find(&back.view.you.hand, "Giant Growth").is_some());
}

/// A foretell deck (issue #1077): Islands and Behold the Multiverse, the card the issue names.
/// Not Ranar the Ever-Watchful, the issue's other card: phase does not yet parse its free foretell
/// or its exile trigger (`support.rs` reports both as gaps).
fn foretell_deck() -> Vec<CardFacts> {
    let mut commander = card(
        "Vendilion Clique",
        Some("{1}{U}{U}"),
        "Legendary Creature — Faerie Wizard",
        "Flash\nFlying",
        Some(("3", "1")),
        1,
    );
    commander.commander = true;
    commander.keywords = vec!["Flash".into(), "Flying".into()];
    let mut behold = card(
        "Behold the Multiverse",
        Some("{3}{U}"),
        "Instant",
        "Scry 2, then draw two cards.\nForetell {1}{U} (During your turn, you may pay {2} and exile this card from your hand face down. Cast it on a later turn for its foretell cost.)",
        None,
        39,
    );
    behold.keywords = vec!["Foretell".into()];
    vec![
        commander,
        card(
            "Island",
            None,
            "Basic Land — Island",
            "({T}: Add {U}.)",
            None,
            60,
        ),
        behold,
    ]
}

/// The foretell deck's game past its opening hand, at the reader's first main phase.
fn foretelling() -> Playtest {
    let (mut game, _) = fish(&foretell_deck(), 7);
    game.act(A::Keep { bottom: vec![] }).expect("keep seven");
    game
}

/// Answer whatever the rules ask (a scry, a payment) with the engine's own answers, until the
/// reader is back in a main phase.
fn settle(game: &mut Playtest) -> PlaytestView {
    for _ in 0..10 {
        let view = game.view();
        if view.stage != Stage::Prompt {
            return view;
        }
        game.act(A::Auto).expect("the engine answers");
    }
    panic!("the rules kept asking");
}

#[test]
fn a_foretold_card_is_exiled_for_two_and_cast_from_exile_on_a_later_turn() {
    let (offered, foretold, next_turn, cast) = engine(|| {
        let mut game = foretelling();
        put_down(&mut game, "Island");
        put_down(&mut game, "Island");
        let behold = in_hand(&mut game, "Behold the Multiverse");
        let offered = find(&game.view().you.hand, "Behold the Multiverse")
            .is_some_and(|c| c.id == behold && c.can_foretell);
        let foretold = game.act(A::Foretell { id: behold }).expect("foretold");
        let foretold = (foretold.happened, settle(&mut game));
        let next_turn = game.act(A::EndTurn).expect("the next turn").view;
        let in_exile = find(&next_turn.you.exile, "Behold the Multiverse")
            .expect("still in exile")
            .id;
        let cast = game.act(A::Play { id: in_exile }).expect("cast from exile");
        settle(&mut game);
        (offered, foretold, next_turn, (cast.happened, game.view()))
    });
    assert!(offered, "the hand card says it can be foretold");

    let (happened, view) = foretold;
    assert!(happened.contains(&H::Foretold {
        seat: YOU,
        name: Some("Behold the Multiverse".into()),
    }));
    assert!(
        !happened.iter().any(|h| matches!(
            h,
            H::Moved {
                to: Place::Exile,
                ..
            }
        )),
        "the foretelling is the move's line"
    );
    let exiled = find(&view.you.exile, "Behold the Multiverse").expect("foretold in exile");
    assert!(exiled.foretold);
    assert!(
        !exiled.castable,
        "a foretold card is cast on a later turn only"
    );
    assert!(
        view.you
            .battlefield
            .iter()
            .filter(|c| c.name == "Island")
            .all(|c| c.tapped),
        "the {{2}} was paid"
    );

    let exiled = find(&next_turn.you.exile, "Behold the Multiverse").unwrap();
    assert!(
        exiled.castable,
        "on the next turn its foretell cost is open"
    );

    let (happened, view) = cast;
    assert!(happened.contains(&H::Cast {
        seat: YOU,
        name: Some("Behold the Multiverse".into()),
    }));
    assert!(find(&view.you.exile, "Behold the Multiverse").is_none());
    assert!(find(&view.you.graveyard, "Behold the Multiverse").is_some());
}

#[test]
fn foretelling_is_refused_saying_why_when_it_cannot_be_paid() {
    let refused = engine(|| {
        let mut game = foretelling();
        let behold = in_hand(&mut game, "Behold the Multiverse");
        assert!(
            !find(&game.view().you.hand, "Behold the Multiverse")
                .unwrap()
                .can_foretell,
            "not offered without {{2}}"
        );
        let refused = game.act(A::Foretell { id: behold }).unwrap_err();
        assert!(find(&game.view().you.hand, "Behold the Multiverse").is_some());
        refused
    });
    assert!(refused.contains("can't be foretold"), "{refused}");
}

/// A modal double-faced card of two faces, each `(name, cost, type line, text)`.
fn modal(
    card_id: &str,
    front: (&str, &str, &str, &str),
    back: (&str, &str, &str, &str),
) -> CardFacts {
    let face = |(name, cost, type_line, text): (&str, &str, &str, &str)| FaceFacts {
        name: name.into(),
        mana_cost: Some(cost.into()),
        type_line: Some(type_line.into()),
        oracle_text: Some(text.into()),
        ..FaceFacts::default()
    };
    CardFacts {
        card_id: card_id.into(),
        // The engine joins a card's faces by their oracle id.
        oracle_id: Some(format!("oracle-{card_id}")),
        name: format!("{} // {}", front.0, back.0),
        quantity: 1,
        type_line: Some(format!("{} // {}", front.2, back.2)),
        layout: Some("modal_dfc".into()),
        faces: vec![face(front), face(back)],
        color_identity: vec!["G".into()],
        ..CardFacts::default()
    }
}

/// Answer whatever the board asks with its first option, until it asks nothing.
fn answer_first(game: &mut Playtest, mut step: PlaytestStep) -> PlaytestStep {
    for _ in 0..8 {
        if step.view.stage != Stage::Prompt {
            return step;
        }
        step = game.act(A::Choose { index: 0 }).expect("answer");
    }
    panic!("the board kept asking: {:?}", step.view.prompt);
}

/// A modal double-faced card played on its back face keeps its printing, there and after it
/// leaves the battlefield on its front face again as a new object (issue #1144).
#[test]
fn a_modal_double_faced_card_played_by_its_back_face_keeps_its_printing() {
    let (played, gone) = engine(|| {
        let mut cards = deck();
        cards.push(modal(
            "print-bala-ged",
            (
                "Bala Ged Recovery",
                "{2}{G}",
                "Sorcery",
                "Return target card from your graveyard to your hand.",
            ),
            ("Bala Ged Sanctuary", "", "Land", "{T}: Add {G}."),
        ));
        let (mut game, _) = fish(&cards, 7);
        game.act(A::Keep { bottom: vec![] }).unwrap();
        let id = in_hand(&mut game, "Bala Ged Recovery");
        let step = game.act(A::Play { id }).unwrap();
        let played = answer_first(&mut game, step);
        let id = find(&played.view.you.battlefield, "Bala Ged Sanctuary")
            .expect("played as its land")
            .id;
        let gone = game
            .act(A::Move {
                id,
                to: Place::Graveyard,
            })
            .unwrap();
        (played, gone)
    });
    let land = find(&played.view.you.battlefield, "Bala Ged Sanctuary").unwrap();
    assert_eq!(land.card_id.as_deref(), Some("print-bala-ged"));
    assert_eq!(land.lane, Lane::Land);
    let card = find(&gone.view.you.graveyard, "Bala Ged Recovery").expect("its front face");
    assert_eq!(card.card_id.as_deref(), Some("print-bala-ged"));
}

/// A commander on its back face is still the commander: it shows so, keeps its printing and goes
/// back to the command zone, its tax raised (issue #1144).
#[test]
fn a_commander_cast_by_its_back_face_is_still_the_commander() {
    let (cast, back) = engine(|| {
        let mut cards = deck();
        cards.retain(|c| !c.commander);
        let mut halvar = modal(
            "print-halvar",
            (
                "Halvar, God of Battle",
                "{2}{G}{G}",
                "Legendary Creature — God",
                "",
            ),
            ("Sword of the Realms", "{1}{G}", "Legendary Artifact", ""),
        );
        halvar.faces[0].power = Some("4".into());
        halvar.faces[0].toughness = Some("4".into());
        halvar.commander = true;
        cards.push(halvar);
        let (mut game, _) = fish(&cards, 7);
        game.act(A::Keep { bottom: vec![] }).unwrap();
        let id = game.view().you.command[0].id;
        let step = game.act(A::Play { id }).unwrap();
        let prompt = step.view.prompt.clone().expect("which face");
        let index = prompt.options.last().expect("two faces").index;
        let cast = game.act(A::Choose { index }).unwrap();
        let cast = answer_first(&mut game, cast);
        let id = find(&cast.view.you.battlefield, "Sword of the Realms")
            .expect("cast as its back face")
            .id;
        let back = game
            .act(A::Move {
                id,
                to: Place::Command,
            })
            .expect("a commander goes to the command zone");
        (cast, back)
    });
    let sword = find(&cast.view.you.battlefield, "Sword of the Realms").unwrap();
    assert!(sword.is_commander);
    assert_eq!(sword.card_id.as_deref(), Some("print-halvar"));
    assert_eq!(back.view.you.command.len(), 1);
    assert!(back.view.you.command[0].is_commander);
    assert_eq!(back.view.you.command[0].tax, 2);
}

/// A game whose library holds Invoke Calamity, cheap for the test, and one instant to cast with
/// it — moved to the graveyard by hand, so the free-cast window offers the graveyard alone.
fn calamity() -> (Playtest, u64, u64) {
    let mut cards: Vec<CardFacts> = deck()
        .into_iter()
        .filter(|c| c.name != "Giant Growth")
        .collect();
    cards.push(card(
        "Invoke Calamity",
        Some("{G}"),
        "Instant",
        "You may cast up to two instant and/or sorcery spells with total mana value 6 or less from your graveyard and/or hand without paying their mana costs. If those spells would be put into your graveyard, exile them instead. Exile Invoke Calamity.",
        None,
        1,
    ));
    cards.push(card(
        "Quick Study",
        Some("{G}"),
        "Instant",
        "Draw a card.",
        None,
        1,
    ));
    let (mut game, _) = fish(&cards, 7);
    game.act(A::Keep { bottom: vec![] }).unwrap();
    let forest = in_hand(&mut game, "Forest");
    game.act(A::Play { id: forest }).unwrap();
    let study = in_hand(&mut game, "Quick Study");
    game.act(A::Move {
        id: study,
        to: Place::Graveyard,
    })
    .expect("into the graveyard");
    let invoke = in_hand(&mut game, "Invoke Calamity");
    (game, invoke, study)
}

/// "You may cast … from your graveyard" is a pick of the cards it may cast (issue #1329): one
/// card or none, where the cards lie, so the board can ask whether to cast before it shows them.
/// Picking none declines, and nothing is cast.
#[test]
fn an_optional_cast_from_the_graveyard_is_a_pick_that_may_be_declined() {
    let (asked, declined, study) = engine(|| {
        let (mut game, invoke, study) = calamity();
        let asked = game.act(A::Play { id: invoke }).unwrap();
        let declined = game.act(A::PickCards { ids: vec![] }).unwrap();
        (asked, declined, study)
    });
    assert_eq!(asked.view.stage, Stage::Prompt, "{:?}", asked.happened);
    let prompt = asked.view.prompt.as_ref().unwrap();
    assert_eq!(prompt.kind, "CastOffer");
    let pick = prompt.pick.as_ref().expect("asked as a pick");
    assert_eq!(pick.purpose, PlaytestPickPurpose::Cast);
    assert_eq!((pick.min, pick.max), (0, 1), "one card, or none");
    assert_eq!(pick.eligible, vec![study]);
    assert_eq!(pick.zone, Some(Place::Graveyard));
    assert!(
        prompt
            .options
            .iter()
            .any(|o| o.cards.iter().any(|c| c.id == study)),
        "the engine's own answers name the card they cast"
    );

    assert_eq!(declined.view.stage, Stage::Main, "{:?}", declined.happened);
    assert!(find(&declined.view.you.graveyard, "Quick Study").is_some());
    assert!(find(&declined.view.you.exile, "Invoke Calamity").is_some());
    assert!(!declined.happened.contains(&H::Cast {
        seat: YOU,
        name: Some("Quick Study".into()),
    }));
}

/// Picking the card casts it from the graveyard, free, and exiles it as it resolves.
#[test]
fn an_optional_cast_from_the_graveyard_casts_the_card_picked() {
    let cast = engine(|| {
        let (mut game, invoke, study) = calamity();
        game.act(A::Play { id: invoke }).unwrap();
        let mut step = game.act(A::PickCards { ids: vec![study] }).unwrap();
        let mut happened = step.happened.clone();
        // The window may be offered again with nothing left in it to cast; close it.
        while step.view.stage == Stage::Prompt {
            step = game.act(A::PickCards { ids: vec![] }).unwrap();
            happened.extend(step.happened.clone());
        }
        (step, happened)
    });
    let (step, happened) = cast;
    assert_eq!(step.view.stage, Stage::Main, "{happened:?}");
    assert!(happened.contains(&H::Cast {
        seat: YOU,
        name: Some("Quick Study".into()),
    }));
    assert!(find(&step.view.you.graveyard, "Quick Study").is_none());
    assert!(find(&step.view.you.exile, "Quick Study").is_some());
}
