//! A goldfish game played end to end on a small Commander deck, every test on the engine's stack.

use crate::cards::{CardFacts, FaceFacts};
use crate::on_engine_stack;
use crate::session::Goldfish;
use crate::view::{GoldfishAction as A, GoldfishView, Happened, Lane, Place, Seat, Stage};

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

/// A game past its opening hand, kept at seven.
fn kept() -> Goldfish {
    let mut game = Goldfish::new(&deck(), &[], 7).expect("a game starts");
    game.act(A::Keep { bottom: vec![] }).expect("keep seven");
    game
}

fn find<'a>(cards: &'a [crate::view::GameCard], name: &str) -> Option<&'a crate::view::GameCard> {
    cards.iter().find(|c| c.name == name)
}

/// Draw until the hand holds `name`, so a test does not depend on the shuffle.
fn in_hand(game: &mut Goldfish, name: &str) -> u64 {
    for _ in 0..80 {
        if let Some(c) = find(&game.view().hand, name) {
            return c.id;
        }
        game.act(A::Draw { count: 1 }).expect("draw");
    }
    panic!("never drew {name}");
}

fn engine<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> T {
    on_engine_stack(work).expect("the engine ran")
}

#[test]
fn a_new_game_waits_on_the_opening_hand_with_the_commander_in_the_command_zone() {
    let view: GoldfishView = engine(|| Goldfish::new(&deck(), &[], 7).unwrap().view());
    assert_eq!(view.stage, Stage::Mulligan);
    assert_eq!(view.turn, 0);
    assert_eq!(view.hand.len(), 7);
    assert_eq!(
        view.library,
        98 - 7,
        "98 in the library, the commander beside it"
    );
    assert_eq!(view.life, 40);
    assert_eq!(view.opponent_life, 40);
    let mulligan = view.mulligan.expect("the mulligan is offered");
    assert_eq!((mulligan.mulligans, mulligan.bottom), (0, 0));
    assert!(mulligan.free_first, "Commander's first mulligan is free");
    assert_eq!(view.command.len(), 1);
    assert_eq!(view.command[0].name, "Fynn, the Fangbearer");
    assert!(view.command[0].is_commander);
    assert_eq!(
        view.command[0].card_id.as_deref(),
        Some("print-fynn--the-fangbearer")
    );
    assert!(
        view.hand.iter().all(|c| c.card_id.is_some()),
        "every card has a printing"
    );
    assert_eq!(
        view.library_lands + view.hand.iter().filter(|c| c.is_land).count() as u32,
        60
    );
}

#[test]
fn the_london_mulligan_bottoms_one_fewer_card_when_the_first_is_free() {
    let (first, second, kept) = engine(|| {
        let mut game = Goldfish::new(&deck(), &[], 7).unwrap();
        let first = game.act(A::Mulligan).unwrap();
        let second = game.act(A::Mulligan).unwrap();
        let bottom = vec![second.view.hand[0].id];
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
    assert_eq!(first.view.hand.len(), 7);
    let m2 = second.view.mulligan.unwrap();
    assert_eq!((m2.mulligans, m2.bottom), (2, 1));
    assert_eq!(kept.view.stage, Stage::Playing);
    assert_eq!(kept.view.turn, 1);
    assert_eq!(
        kept.view.hand.len(),
        6,
        "the player on the play does not draw on turn 1"
    );
    assert_eq!(
        kept.happened[0],
        Happened::Kept {
            size: 6,
            bottomed: 1
        }
    );
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
    assert!(first.happened.contains(&Happened::Played {
        name: "Forest".into()
    }));
    assert_eq!(first.view.mana_open, 1);
    let forest = find(&first.view.battlefield, "Forest").unwrap();
    assert_eq!(forest.lane, Lane::Land);
    assert_eq!(
        forest.card_id.as_deref(),
        Some("print-forest"),
        "the printing follows the card"
    );
    assert!(second.happened.contains(&Happened::Put {
        name: "Forest".into(),
        from: Place::Hand,
        to: Place::Battlefield,
    }));
    assert_eq!(second.view.mana_open, 2);
}

#[test]
fn a_spell_is_cast_from_untapped_mana_and_put_by_hand_without_it() {
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
        cast.happened.contains(&Happened::Cast {
            name: "Llanowar Elves".into(),
            from: Place::Hand
        }),
        "{:?}",
        cast.happened
    );
    let elf = find(&cast.view.battlefield, "Llanowar Elves").unwrap();
    assert_eq!(elf.lane, Lane::Creature);
    assert_eq!((elf.power, elf.toughness), (Some(1), Some(1)));
    assert!(
        find(&cast.view.battlefield, "Forest").unwrap().tapped,
        "the cast tapped the Forest"
    );
    assert_eq!(cast.view.mana_open, 0, "a summoning-sick elf makes no mana");
    assert!(unpaid
        .happened
        .iter()
        .any(|h| matches!(h, Happened::Put { name, .. } if name == "Grizzly Bears")));
}

#[test]
fn the_next_turn_untaps_draws_and_counts_only_the_readers_turns() {
    let next = engine(|| {
        let mut game = kept();
        let forest = in_hand(&mut game, "Forest");
        game.act(A::Play { id: forest }).unwrap();
        let id = game.view().battlefield[0].id;
        game.act(A::Tap {
            ids: vec![id],
            tapped: true,
        })
        .unwrap();
        let hand = game.view().hand.len();
        let next = game.act(A::NextTurn).unwrap();
        assert_eq!(next.view.hand.len(), hand + 1, "drew for the turn");
        next
    });
    assert_eq!(next.view.turn, 2);
    assert!(next.view.battlefield.iter().all(|c| !c.tapped), "untapped");
    assert!(next.happened.contains(&Happened::TurnBegan { turn: 2 }));
    assert!(next.happened.iter().any(|h| matches!(
        h,
        Happened::Moved {
            from: Place::LibraryTop,
            to: Place::Hand,
            ..
        }
    )));
}

#[test]
fn a_turn_passed_over_the_hand_size_waits_for_the_reader_to_choose_the_discard() {
    let (asked, refused, short, done, chosen) = engine(|| {
        let mut game = kept();
        let short_of_ten = 10 - game.view().hand.len() as u32;
        game.act(A::Draw {
            count: short_of_ten,
        })
        .unwrap();
        let asked = game.act(A::NextTurn).unwrap();
        let refused = game.act(A::Draw { count: 1 }).unwrap_err();
        // The oldest three, never the newest: what the engine's own first answer would not be.
        let chosen: Vec<(u64, String)> = asked.view.hand[..3]
            .iter()
            .map(|c| (c.id, c.name.clone()))
            .collect();
        let short = game
            .act(A::Discard {
                ids: vec![chosen[0].0],
            })
            .unwrap_err();
        assert_eq!(game.view(), asked.view, "a refusal changed nothing");
        let done = game
            .act(A::Discard {
                ids: chosen.iter().map(|c| c.0).collect(),
            })
            .unwrap();
        (asked, refused, short, done, chosen)
    });
    assert_eq!(asked.view.stage, Stage::Discard);
    assert_eq!(asked.view.discard, 3);
    assert_eq!(asked.view.turn, 1, "the turn has not passed yet");
    assert_eq!(asked.view.hand.len(), 10, "nothing was discarded for them");
    assert!(asked.view.graveyard.is_empty());
    assert!(!asked
        .happened
        .iter()
        .any(|h| matches!(h, Happened::Chose { .. })));
    assert_eq!(refused, "Discard down to your hand size first.");
    assert_eq!(short, "Pick 3 cards to discard first.");

    assert_eq!(done.view.stage, Stage::Playing);
    assert_eq!(done.view.discard, 0);
    assert_eq!(done.view.turn, 2);
    assert_eq!(done.view.hand.len(), 8, "seven kept, and the turn's draw");
    let mut buried: Vec<&str> = done
        .view
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
                Happened::Moved {
                    from: Place::Hand,
                    to: Place::Graveyard,
                    ..
                }
            )
        })
        .count();
    assert_eq!(discarded, 3);
    assert!(done.happened.contains(&Happened::TurnBegan { turn: 2 }));
}

#[test]
fn a_discard_nobody_asked_for_is_refused() {
    let refused = engine(|| {
        let mut game = kept();
        let id = game.view().hand[0].id;
        game.act(A::Discard { ids: vec![id] }).unwrap_err()
    });
    assert_eq!(refused, "There is nothing to discard.");
}

#[test]
fn a_life_total_at_zero_does_not_end_the_game() {
    let view = engine(|| {
        let mut game = kept();
        let step = game
            .act(A::SetLife {
                seat: Seat::Opponent,
                life: 0,
            })
            .unwrap();
        assert!(step.happened.contains(&Happened::LifeSet {
            seat: Seat::Opponent,
            life: 0,
            was: 40
        }));
        game.act(A::SetLife {
            seat: Seat::You,
            life: -3,
        })
        .unwrap();
        game.act(A::NextTurn).unwrap().view
    });
    assert_eq!(view.opponent_life, 0);
    assert_eq!(view.life, -3);
    assert_eq!(view.turn, 2);
}

#[test]
fn the_commander_cast_unpaid_still_raises_its_tax() {
    let (on_field, back) = engine(|| {
        let mut game = kept();
        let fynn = game.view().command[0].id;
        let on_field = game.act(A::Play { id: fynn }).unwrap();
        let id = find(&on_field.view.battlefield, "Fynn, the Fangbearer")
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
    let fynn = find(&on_field.view.battlefield, "Fynn, the Fangbearer").unwrap();
    assert_eq!(fynn.card_id.as_deref(), Some("print-fynn--the-fangbearer"));
    assert_eq!(back.view.command.len(), 1);
    assert_eq!(back.view.command[0].tax, 2);
}

#[test]
fn counters_change_power_and_toughness() {
    let creature = engine(|| {
        let mut game = kept();
        let bear = in_hand(&mut game, "Grizzly Bears");
        let step = game
            .act(A::Move {
                id: bear,
                to: Place::Battlefield,
            })
            .unwrap();
        let id = find(&step.view.battlefield, "Grizzly Bears").unwrap().id;
        game.act(A::Counters {
            id,
            kind: "+1/+1".into(),
            delta: 2,
        })
        .unwrap();
        find(&game.view().battlefield, "Grizzly Bears")
            .unwrap()
            .clone()
    });
    assert_eq!((creature.power, creature.toughness), (Some(4), Some(4)));
    assert_eq!(creature.counters.len(), 1);
    assert_eq!(creature.counters[0].count, 2);
    assert_eq!(creature.counters[0].kind, "+1/+1");
}

/// Issue #991: a token the deck keeps is offered and drawn in the printing the reader set for it,
/// not phase's.
#[test]
fn a_token_is_offered_and_drawn_in_the_printing_the_deck_sets() {
    let (preset, oracle, source) = crate::tokens::a_treasure();
    let token = crate::tokens::a_treasure_facts(&oracle, &source);
    let mut cards = deck();
    cards.push(card(&source, Some("{1}{G}"), "Enchantment", "", None, 1));
    let view = engine(move || {
        let mut game = Goldfish::new(&cards, &[token], 7).unwrap();
        game.act(A::Keep { bottom: vec![] }).unwrap();
        game.act(A::CreateToken { preset, count: 1 }).unwrap().view
    });
    let offer = view.tokens.iter().find(|t| t.name == "Treasure").unwrap();
    assert_eq!(offer.card_id.as_deref(), Some("deck-treasure"));
    let made = view.battlefield.iter().find(|c| c.is_token).unwrap();
    assert_eq!(made.card_id.as_deref(), Some("deck-treasure"));
}

#[test]
fn a_card_goes_to_the_bottom_of_the_library_and_a_token_leaving_play_is_gone() {
    let (library, tokens) = engine(|| {
        let mut game = kept();
        let bear = in_hand(&mut game, "Grizzly Bears");
        let before = game.view().library;
        let step = game
            .act(A::Move {
                id: bear,
                to: Place::LibraryBottom,
            })
            .unwrap();
        assert_eq!(step.view.library, before + 1);
        assert_eq!(step.view.library_cards.len() as u32, step.view.library);
        assert_eq!(
            step.view.library_cards.last().unwrap().name,
            "Grizzly Bears",
            "the bottom is last"
        );
        let top = step.view.library_cards[0].name.clone();
        let drawn = game.act(A::Draw { count: 1 }).unwrap();
        assert_eq!(
            drawn.view.hand.last().unwrap().name,
            top,
            "a draw takes the first card"
        );
        let elf = in_hand(&mut game, "Llanowar Elves");
        let step = game
            .act(A::Move {
                id: elf,
                to: Place::Battlefield,
            })
            .unwrap();
        let id = find(&step.view.battlefield, "Llanowar Elves").unwrap().id;
        let step = game.act(A::TokenCopy { id }).unwrap();
        let copies: Vec<_> = step
            .view
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
        (step.view.library, gone.view)
    });
    assert!(library > 0);
    assert!(tokens.battlefield.iter().all(|c| !c.is_token));
    assert!(tokens.graveyard.iter().all(|c| !c.is_token));
}

#[test]
fn an_action_before_the_keep_is_refused_and_changes_nothing() {
    let (refused, hand) = engine(|| {
        let mut game = Goldfish::new(&deck(), &[], 7).unwrap();
        let hand = game.view().hand.len();
        (
            game.act(A::NextTurn).unwrap_err(),
            game.view().hand.len() == hand,
        )
    });
    assert_eq!(refused, "Keep or mulligan the opening hand first.");
    assert!(hand);
}

#[test]
fn the_same_seed_deals_the_same_hand() {
    let (a, b) = engine(|| {
        let a = Goldfish::new(&deck(), &[], 42).unwrap().view();
        let b = Goldfish::new(&deck(), &[], 42).unwrap().view();
        (a, b)
    });
    let names = |v: &GoldfishView| v.hand.iter().map(|c| c.name.clone()).collect::<Vec<_>>();
    assert_eq!(names(&a), names(&b));
}

#[test]
fn a_spell_with_one_target_is_cast_at_it() {
    let step = engine(|| {
        let mut game = kept();
        let forest = in_hand(&mut game, "Forest");
        game.act(A::Play { id: forest }).unwrap();
        let bear = in_hand(&mut game, "Grizzly Bears");
        game.act(A::Move {
            id: bear,
            to: Place::Battlefield,
        })
        .unwrap();
        let growth = in_hand(&mut game, "Giant Growth");
        game.act(A::Play { id: growth }).unwrap()
    });
    assert!(step.happened.contains(&Happened::Cast {
        name: "Giant Growth".into(),
        from: Place::Hand
    }));
    let bear = find(&step.view.battlefield, "Grizzly Bears").unwrap();
    assert_eq!((bear.power, bear.toughness), (Some(5), Some(5)));
    assert!(find(&step.view.graveyard, "Giant Growth").is_some());
}

#[test]
fn a_spell_that_asks_for_a_choice_is_put_by_hand_and_the_game_is_as_it_was() {
    let step = engine(|| {
        let mut game = kept();
        let forest = in_hand(&mut game, "Forest");
        game.act(A::Play { id: forest }).unwrap();
        for _ in 0..2 {
            let bear = in_hand(&mut game, "Grizzly Bears");
            game.act(A::Move {
                id: bear,
                to: Place::Battlefield,
            })
            .unwrap();
        }
        let growth = in_hand(&mut game, "Giant Growth");
        game.act(A::Play { id: growth }).unwrap()
    });
    assert!(
        step.happened.contains(&Happened::Put {
            name: "Giant Growth".into(),
            from: Place::Hand,
            to: Place::Graveyard,
        }),
        "{:?}",
        step.happened
    );
    assert!(
        !find(&step.view.battlefield, "Forest").unwrap().tapped,
        "the attempt paid nothing"
    );
    let bear = find(&step.view.battlefield, "Grizzly Bears").unwrap();
    assert_eq!(bear.power, Some(2));
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
        let mut game = Goldfish::new(&cards, &[], 7).unwrap();
        game.act(A::Keep { bottom: vec![] }).unwrap();
        let id = in_hand(&mut game, "Bala Ged Recovery");
        let card = find(&game.view().hand, "Bala Ged Recovery")
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
    assert!(find(&view.graveyard, "Bala Ged Recovery").is_some());
}
