//! What phase.rs's own board shows and offers that this one now does too (phase 0.132.0): a
//! library's top the reader may look at or play from, an opponent's revealed hand, a face-down
//! card the reader may look at, the rules' marks on a card and a player, a tutor's find told as a
//! find, and the questions the generic options could not answer — an order, a division, a cost
//! paid with cards. Every test against the goldfish, on the engine's stack.

use crate::cards::CardFacts;
use crate::on_engine_stack;
use crate::view::{GameCard, Place};

use super::session::Playtest;
use super::view::{
    Difficulty, PlaytestAction as A, PlaytestCounterShare, PlaytestHappened as H,
    PlaytestPickPurpose, PlaytestStage as Stage, PlaytestStep,
};

fn engine<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> T {
    on_engine_stack(work).expect("the engine ran")
}

fn card(name: &str, cost: Option<&str>, type_line: &str, text: &str, quantity: u32) -> CardFacts {
    let creature = type_line.contains("Creature");
    CardFacts {
        card_id: format!(
            "print-{}",
            name.to_lowercase().replace([' ', ',', '\''], "-")
        ),
        name: name.into(),
        quantity,
        mana_cost: cost.map(Into::into),
        type_line: Some(type_line.into()),
        oracle_text: Some(text.into()),
        power: creature.then(|| "2".into()),
        toughness: creature.then(|| "2".into()),
        cmc: Some(cost.map_or(0.0, |c| c.matches('{').count() as f64)),
        layout: Some("normal".into()),
        colors: vec!["G".into()],
        color_identity: vec!["G".into()],
        ..CardFacts::default()
    }
}

/// Forests and Bears, and `extra` one of each.
fn deck(extra: Vec<CardFacts>) -> Vec<CardFacts> {
    let mut cards = vec![
        card("Forest", None, "Basic Land — Forest", "({T}: Add {G}.)", 40),
        card("Grizzly Bears", Some("{1}{G}"), "Creature — Bear", "", 19),
    ];
    cards.extend(extra);
    cards
}

/// A game of `cards` against the goldfish, kept at seven, at the reader's first main phase.
fn kept(cards: &[CardFacts]) -> Playtest {
    let (mut game, _) = Playtest::new(cards, &[], &[], 7, Difficulty::default()).expect("a game");
    game.act(A::Keep { bottom: vec![] }).expect("keep seven");
    game
}

fn find<'a>(cards: &'a [GameCard], name: &str) -> Option<&'a GameCard> {
    cards.iter().find(|c| c.name == name)
}

/// A card of `name` from wherever the reader's cards are — hand, library — by hand, put `to`.
fn put(game: &mut Playtest, name: &str, to: Place) -> PlaytestStep {
    let view = game.view();
    let id = find(&view.you.hand, name)
        .or_else(|| find(&view.you.library_cards, name))
        .unwrap_or_else(|| panic!("{name} is in the hand or the library"))
        .id;
    game.act(A::Move { id, to }).expect("put by hand")
}

/// Issue: a card the reader may look at on top of their library, and play from there. Future
/// Sight plays with the top card revealed and lets its controller play it (CR 401.5) — phase's
/// client shows it and plays it; the board did neither.
#[test]
fn the_top_of_the_library_under_future_sight_is_shown_and_played() {
    let (before, after, played) = engine(|| {
        let future_sight = card(
            "Future Sight",
            Some("{2}{U}{U}{U}"),
            "Enchantment",
            "Play with the top card of your library revealed.\nYou may play lands and cast spells from the top of your library.",
            1,
        );
        let mut game = kept(&deck(vec![future_sight]));
        put(&mut game, "Forest", Place::LibraryTop);
        let before = game.view();
        put(&mut game, "Future Sight", Place::Battlefield);
        put(&mut game, "Forest", Place::LibraryTop);
        let after = game.view();
        let top = after.you.library_top.clone().expect("the top is shown");
        let played = game
            .act(A::Play { id: top.id })
            .expect("played from the top");
        (before, after, played)
    });
    assert!(
        before.you.library_top.is_none(),
        "hidden without Future Sight"
    );
    let top = after.you.library_top.as_ref().unwrap();
    assert_eq!(top.name, "Forest");
    assert!(after.you.library_top_revealed, "revealed to every player");
    assert!(top.castable, "the land drop plays it from the top");
    assert!(
        after.opponents[0].library_top.is_none(),
        "the goldfish's own top stays hidden"
    );
    assert!(
        played
            .view
            .you
            .battlefield
            .iter()
            .filter(|c| c.name == "Forest")
            .count()
            >= 1,
        "{:?}",
        played.happened
    );
    assert!(
        played
            .happened
            .iter()
            .any(|h| matches!(h, H::Played { name, .. } if name == "Forest")),
        "{:?}",
        played.happened
    );
}

/// "You may look at the top card of your library any time" is the reader's alone: shown to them,
/// not revealed.
#[test]
fn a_top_card_the_reader_may_look_at_is_theirs_alone() {
    let view = engine(|| {
        let vizier = card(
            "Vizier of the Menagerie",
            Some("{3}{G}"),
            "Creature — Naga Cleric",
            "You may look at the top card of your library any time.\nYou may cast creature spells from the top of your library.",
            1,
        );
        let mut game = kept(&deck(vec![vizier]));
        put(&mut game, "Vizier of the Menagerie", Place::Battlefield);
        put(&mut game, "Grizzly Bears", Place::LibraryTop);
        game.view()
    });
    let top = view.you.library_top.as_ref().expect("the top is shown");
    assert_eq!(top.name, "Grizzly Bears");
    assert!(!view.you.library_top_revealed, "looked at, not revealed");
}

/// An opponent's hand the reader may see — Telepathy's "your opponents play with their hands
/// revealed" — is sent as its cards; any other opponent's hand stays a count.
#[test]
fn an_opponents_revealed_hand_is_shown() {
    let (before, after) = engine(|| {
        let telepathy = card(
            "Telepathy",
            Some("{U}"),
            "Enchantment",
            "Your opponents play with their hands revealed.",
            1,
        );
        let mut game = kept(&deck(vec![telepathy]));
        let before = game.view();
        put(&mut game, "Telepathy", Place::Battlefield);
        (before, game.view())
    });
    let fish = &before.opponents[0];
    assert!(fish.hand.is_empty() && fish.hand_count == 7);
    let fish = &after.opponents[0];
    assert_eq!(
        fish.hand.len() as u32,
        fish.hand_count,
        "every card revealed"
    );
    assert!(fish.hand.iter().all(|c| !c.name.is_empty()));
}

/// The rules' marks on a permanent: a creature that just came under the reader's control is
/// summoning sick (CR 302.6) until their next turn.
#[test]
fn a_creature_new_to_the_battlefield_is_summoning_sick_until_the_next_turn() {
    let (now, later) = engine(|| {
        let mut game = kept(&deck(vec![]));
        let now = put(&mut game, "Grizzly Bears", Place::Battlefield).view;
        game.act(A::EndTurn).unwrap();
        game.act(A::EndTurn).unwrap();
        (now, game.view())
    });
    assert!(find(&now.you.battlefield, "Grizzly Bears").unwrap().sick);
    let bears = find(&later.you.battlefield, "Grizzly Bears").unwrap();
    assert!(!bears.sick, "{:?}", later.stage);
    assert_eq!(bears.damage, 0);
    assert!(!bears.face_down && !bears.phased_out);
    assert_eq!(now.lands_left, Some(1), "the turn's land drop is left");
}

/// A tutor's find is not a draw: it is told as a move from the library to the hand, and the card
/// it revealed is told as revealed.
#[test]
fn a_tutors_find_is_told_as_found_and_revealed_not_drawn() {
    let found = engine(|| {
        let scrying = card(
            "Sylvan Scrying",
            Some("{1}{G}"),
            "Sorcery",
            "Search your library for a land card, reveal it, put it into your hand, then shuffle.",
            1,
        );
        let mut game = kept(&deck(vec![scrying]));
        let id = find(
            &put(&mut game, "Sylvan Scrying", Place::Hand).view.you.hand,
            "Sylvan Scrying",
        )
        .unwrap()
        .id;
        let asked = game
            .act(A::Play { id })
            .expect("cast unpaid in the sandbox");
        let pick = asked
            .view
            .prompt
            .as_ref()
            .and_then(|p| p.pick.clone())
            .unwrap_or_else(|| panic!("a search: {:?}", asked.view.prompt));
        assert_eq!(pick.purpose, PlaytestPickPurpose::Search);
        let forest = pick
            .cards
            .iter()
            .find(|c| c.name == "Forest")
            .expect("a Forest to find")
            .id;
        game.act(A::PickCards { ids: vec![forest] }).expect("found")
    });
    assert!(
        !found.happened.iter().any(|h| matches!(h, H::Drew { .. })),
        "{:?}",
        found.happened
    );
    assert!(
        found.happened.iter().any(|h| matches!(
            h,
            H::Moved { name: Some(name), from: Place::LibraryTop, to: Place::Hand, .. }
                if name == "Forest"
        )),
        "{:?}",
        found.happened
    );
    assert!(
        found
            .happened
            .iter()
            .any(|h| matches!(h, H::Revealed { names, .. } if names == &["Forest"])),
        "{:?}",
        found.happened
    );
}

/// The reader's own face-down permanent is the card underneath to them (CR 708.5): its name and
/// printing, marked face down.
#[test]
fn the_readers_own_manifest_shows_its_card_marked_face_down() {
    let step = engine(|| {
        let summons = card(
            "Soul Summons",
            Some("{1}{W}"),
            "Sorcery",
            "Manifest the top card of your library.",
            1,
        );
        let mut game = kept(&deck(vec![summons]));
        put(&mut game, "Grizzly Bears", Place::LibraryTop);
        let id = find(
            &put(&mut game, "Soul Summons", Place::Hand).view.you.hand,
            "Soul Summons",
        )
        .unwrap()
        .id;
        game.act(A::Play { id }).expect("cast")
    });
    let down: Vec<&GameCard> = step
        .view
        .you
        .battlefield
        .iter()
        .filter(|c| c.face_down)
        .collect();
    assert_eq!(down.len(), 1, "{:?}", step.happened);
    assert_eq!(down[0].name, "Grizzly Bears");
    assert_eq!(down[0].card_id.as_deref(), Some("print-grizzly-bears"));
}

/// "Look at the top N, put them back in any order" is asked as an order to pick, never taken in
/// the library's own order.
#[test]
fn putting_cards_back_in_any_order_asks_the_order() {
    let asked = engine(|| {
        let index = card(
            "Index",
            Some("{U}"),
            "Sorcery",
            "Look at the top five cards of your library, then put them back in any order.",
            1,
        );
        let mut game = kept(&deck(vec![index]));
        let id = find(&put(&mut game, "Index", Place::Hand).view.you.hand, "Index")
            .unwrap()
            .id;
        game.act(A::Play { id }).expect("cast")
    });
    assert_eq!(asked.view.stage, Stage::Prompt, "{:?}", asked.happened);
    let prompt = asked.view.prompt.as_ref().unwrap();
    let pick = prompt
        .pick
        .as_ref()
        .unwrap_or_else(|| panic!("{} {:?}", prompt.kind, prompt.options));
    assert!(pick.ordered, "{pick:?}");
    assert_eq!(pick.cards.len(), 5);
}

/// Cast `name` from the hand (put there by hand first), and the step it asks or ends at.
fn cast(game: &mut Playtest, name: &str) -> PlaytestStep {
    let id = find(&put(game, name, Place::Hand).view.you.hand, name)
        .unwrap()
        .id;
    game.act(A::Play { id }).expect("cast")
}

/// A modal spell's modes are told by their words, and a kicker by paying it or not — rows the
/// board could not tell apart.
#[test]
fn a_modes_words_and_a_kickers_yes_name_their_answers() {
    let (modes, kicker) = engine(|| {
        let charm = card(
            "Test Charm",
            Some("{G}"),
            "Instant",
            "Choose one —\n• You gain 3 life.\n• Draw a card.",
            1,
        );
        let burst = card(
            "Burst Lightning",
            Some("{R}"),
            "Instant",
            "Kicker {4}\nBurst Lightning deals 2 damage to any target. If this spell was kicked, it deals 4 damage instead.",
            1,
        );
        let mut game = kept(&deck(vec![charm, burst]));
        let modes = cast(&mut game, "Test Charm");
        game.act(A::Cancel).ok();
        // Mana enough to kick it: an optional cost too dear to pay is not asked about.
        game.act(A::Mana {
            kind: crate::view::ManaKind::Red,
            delta: 5,
        })
        .expect("mana by hand");
        let mut kicker = cast(&mut game, "Burst Lightning");
        // At the goldfish, if the target comes first.
        if kicker
            .view
            .prompt
            .as_ref()
            .is_some_and(|p| p.kind == "TargetSelection")
        {
            kicker = game.act(A::Choose { index: 1 }).expect("at the goldfish");
        }
        (modes, kicker)
    });
    let prompt = modes.view.prompt.as_ref().expect("which mode");
    let labels: Vec<Option<String>> = prompt.options.iter().map(|o| o.label.clone()).collect();
    assert!(
        labels.iter().flatten().any(|l| l.contains("gain 3 life")),
        "{} {:?}",
        prompt.kind,
        prompt.options
    );
    let prompt = kicker.view.prompt.as_ref().expect("kick it?");
    let yes: Vec<Option<bool>> = prompt.options.iter().map(|o| o.yes).collect();
    assert!(
        yes.contains(&Some(true)) && yes.contains(&Some(false)),
        "{} {:?}",
        prompt.kind,
        prompt.options
    );
}

/// Damage divided as the reader chooses among two targets (CR 601.2d) is asked as a division,
/// never taken as the engine's even split.
#[test]
fn damage_divided_among_targets_is_asked_as_a_division() {
    let (asked, divided) = engine(|| {
        let bolt = card(
            "Forked Bolt",
            Some("{R}"),
            "Sorcery",
            "Forked Bolt deals 2 damage divided as you choose among one or two targets.",
            1,
        );
        let mut game = kept(&deck(vec![bolt]));
        put(&mut game, "Grizzly Bears", Place::Battlefield);
        put(&mut game, "Grizzly Bears", Place::Battlefield);
        let mut step = cast(&mut game, "Forked Bolt");
        // Two targets: the reader's two Bears.
        for _ in 0..4 {
            let Some(prompt) = step.view.prompt.clone() else {
                break;
            };
            if prompt.distribute.is_some() {
                break;
            }
            let bears: Vec<u64> = step
                .view
                .you
                .battlefield
                .iter()
                .filter(|c| c.name == "Grizzly Bears")
                .map(|c| c.id)
                .collect();
            step = if let Some(pick) = &prompt.pick {
                let ids: Vec<u64> = bears
                    .iter()
                    .copied()
                    .filter(|id| pick.eligible.contains(id))
                    .take(pick.max as usize)
                    .collect();
                game.act(A::PickCards { ids }).expect("targets")
            } else {
                let at = prompt
                    .options
                    .iter()
                    .find(|o| o.cards.iter().any(|c| bears.contains(&c.id)))
                    .unwrap_or_else(|| panic!("{} {:?}", prompt.kind, prompt.options));
                game.act(A::Choose { index: at.index }).expect("a target")
            };
        }
        let asked = step.clone();
        let distribute = asked
            .view
            .prompt
            .as_ref()
            .and_then(|p| p.distribute.clone())
            .unwrap_or_else(|| panic!("{:?}", asked.view.prompt));
        let shares = distribute
            .targets
            .iter()
            .enumerate()
            .map(|(i, t)| super::view::PlaytestShare {
                id: t.card.as_ref().map(|c| c.id),
                player: t.player,
                amount: if i == 0 { 2 } else { 0 },
            })
            .collect();
        let refused = game.act(A::Distribute { shares }).unwrap_err();
        assert!(refused.contains("at least"), "{refused}");
        let shares = distribute
            .targets
            .iter()
            .map(|t| super::view::PlaytestShare {
                id: t.card.as_ref().map(|c| c.id),
                player: t.player,
                amount: 1,
            })
            .collect();
        (asked, game.act(A::Distribute { shares }).expect("divided"))
    });
    let distribute = asked.view.prompt.unwrap().distribute.unwrap();
    assert_eq!(distribute.total, 2);
    assert_eq!(distribute.targets.len(), 2);
    assert!(distribute.targets.iter().all(|t| t.min == 1));
    let damaged: Vec<u32> = divided
        .view
        .you
        .battlefield
        .iter()
        .filter(|c| c.name == "Grizzly Bears")
        .map(|c| c.damage)
        .collect();
    assert_eq!(damaged, vec![1, 1], "{:?}", divided.happened);
}

/// Answer each question the way `answer` says until `done` holds, at most `n` times.
fn answer_until(
    game: &mut Playtest,
    mut step: PlaytestStep,
    n: usize,
    done: impl Fn(&PlaytestStep) -> bool,
    want: &[u64],
) -> PlaytestStep {
    for _ in 0..n {
        if done(&step) {
            break;
        }
        let Some(prompt) = step.view.prompt.clone() else {
            break;
        };
        step = if let Some(pick) = &prompt.pick {
            let ids: Vec<u64> = want
                .iter()
                .copied()
                .filter(|id| pick.eligible.contains(id))
                .take(pick.max.max(1) as usize)
                .collect();
            game.act(A::PickCards { ids }).expect("picked")
        } else {
            let at = prompt
                .options
                .iter()
                .find(|o| o.cards.iter().any(|c| want.contains(&c.id)))
                .or(prompt.options.first())
                .unwrap_or_else(|| panic!("{} {:?}", prompt.kind, prompt.options));
            game.act(A::Choose { index: at.index }).expect("answered")
        };
    }
    step
}

fn ids_of(step: &PlaytestStep, name: &str) -> Vec<u64> {
    step.view
        .you
        .battlefield
        .iter()
        .filter(|c| c.name == name)
        .map(|c| c.id)
        .collect()
}

/// Issue #1745: crewing a Vehicle is a pick of creatures whose power reaches its crew number
/// (CR 702.122a), never the engine's few listed sets; too little power is refused.
#[test]
fn crewing_is_a_pick_of_creatures_with_power_enough() {
    let (asked, refused, crewed) = engine(|| {
        let wagon = card("Test Wagon", Some("{3}"), "Artifact — Vehicle", "Crew 3", 1);
        let mut game = kept(&deck(vec![wagon]));
        put(&mut game, "Grizzly Bears", Place::Battlefield);
        put(&mut game, "Grizzly Bears", Place::Battlefield);
        let step = put(&mut game, "Test Wagon", Place::Battlefield);
        let wagon = ids_of(&step, "Test Wagon")[0];
        let bears = ids_of(&step, "Grizzly Bears");
        let step = game.act(A::Activate { id: wagon }).expect("crew it");
        let asked = answer_until(
            &mut game,
            step,
            4,
            |s| {
                s.view
                    .prompt
                    .as_ref()
                    .and_then(|p| p.pick.as_ref())
                    .is_some_and(|p| p.purpose == PlaytestPickPurpose::Crew)
            },
            &[wagon],
        );
        let refused = game
            .act(A::PickCards {
                ids: vec![bears[0]],
            })
            .unwrap_err();
        let crewed = game.act(A::PickCards { ids: bears }).expect("crewed");
        (asked, refused, crewed)
    });
    let pick = asked.view.prompt.unwrap().pick.unwrap();
    assert_eq!(pick.power_min, Some(3));
    assert_eq!(pick.eligible.len(), 2);
    assert_eq!(pick.contributions, vec![2, 2]);
    assert!(refused.contains("at least 3"), "{refused}");
    let wagon = find(&crewed.view.you.battlefield, "Test Wagon").unwrap();
    assert!(
        wagon.type_line.contains("Creature"),
        "crewed, it is a creature: {wagon:?}"
    );
    assert!(
        crewed
            .view
            .you
            .battlefield
            .iter()
            .filter(|c| c.name == "Grizzly Bears")
            .all(|c| c.tapped),
        "both Bears tapped to crew it"
    );
}

/// Issue #1745: "remove any number of counters" (Rhys the Evermore, Tetravus; CR 107.1c) asks
/// how many of each kind, never only none or all.
#[test]
fn removing_any_number_of_counters_asks_how_many() {
    let (asked, removed) = engine(|| {
        let rod = card(
            "Test Rod",
            Some("{1}"),
            "Artifact",
            "{T}: Remove any number of counters from target creature you control.",
            1,
        );
        let mut game = kept(&deck(vec![rod]));
        let step = put(&mut game, "Grizzly Bears", Place::Battlefield);
        let bear = ids_of(&step, "Grizzly Bears")[0];
        game.act(A::Counters {
            id: bear,
            kind: "+1/+1".into(),
            delta: 3,
        })
        .expect("counters by hand");
        let step = put(&mut game, "Test Rod", Place::Battlefield);
        let rod = ids_of(&step, "Test Rod")[0];
        let step = game.act(A::Activate { id: rod }).expect("activated");
        let mut asked = answer_until(
            &mut game,
            step,
            6,
            |s| s.view.prompt.as_ref().is_some_and(|p| p.counters.is_some()),
            &[bear],
        );
        // The ability resolves once the reader passes.
        for _ in 0..3 {
            if asked
                .view
                .prompt
                .as_ref()
                .is_some_and(|p| p.counters.is_some())
            {
                break;
            }
            asked = game.act(A::Pass).expect("resolve it");
            asked = answer_until(
                &mut game,
                asked,
                4,
                |s| s.view.prompt.as_ref().is_some_and(|p| p.counters.is_some()),
                &[bear],
            );
        }
        let counters = asked
            .view
            .prompt
            .as_ref()
            .and_then(|p| p.counters.clone())
            .unwrap_or_else(|| panic!("{:?}", asked.view.prompt));
        let kind = counters.kinds[0].kind.clone();
        let refused = game
            .act(A::MoveCounters {
                shares: vec![PlaytestCounterShare {
                    kind: kind.clone(),
                    to: None,
                    count: 4,
                }],
            })
            .unwrap_err();
        assert!(refused.contains("has 3"), "{refused}");
        let removed = game
            .act(A::MoveCounters {
                shares: vec![PlaytestCounterShare {
                    kind,
                    to: None,
                    count: 2,
                }],
            })
            .expect("two removed");
        (counters, removed)
    });
    assert_eq!(asked.kinds.len(), 1);
    assert_eq!(asked.kinds[0].count, 3);
    assert!(asked.destinations.is_empty(), "a removal, not a move");
    let bear = find(&removed.view.you.battlefield, "Grizzly Bears").unwrap();
    assert_eq!(bear.power, Some(3), "one +1/+1 counter left: {bear:?}");
}

/// Issue #1745: five triggers at once are put in order as the reader chooses — phase lists only
/// two of their 120 orders past four.
#[test]
fn five_triggers_are_put_in_any_order() {
    let (asked, ordered) = engine(|| {
        let wardens: Vec<CardFacts> = (1..=5)
            .map(|n| {
                card(
                    &format!("Test Shrine {n}"),
                    Some("{1}"),
                    "Enchantment",
                    &format!("Whenever a creature you control enters, you gain {n} life."),
                    1,
                )
            })
            .collect();
        let mut game = kept(&deck(wardens));
        for n in 1..=5 {
            put(&mut game, &format!("Test Shrine {n}"), Place::Battlefield);
        }
        put(&mut game, "Forest", Place::Battlefield);
        put(&mut game, "Forest", Place::Battlefield);
        let mut step = cast(&mut game, "Grizzly Bears");
        for _ in 0..6 {
            if step
                .view
                .prompt
                .as_ref()
                .is_some_and(|p| p.triggers.is_some())
            {
                break;
            }
            step = if step.view.prompt.is_some() {
                answer_until(&mut game, step, 1, |_| false, &[])
            } else {
                game.act(A::Pass).expect("resolve the Bears")
            };
        }
        let asked = step.clone();
        let triggers = asked
            .view
            .prompt
            .as_ref()
            .and_then(|p| p.triggers.clone())
            .unwrap_or_else(|| panic!("{:?}", asked.view.prompt));
        let refused = game
            .act(A::OrderTriggers {
                order: vec![0, 0, 1, 2, 3],
            })
            .unwrap_err();
        assert!(refused.contains("once"), "{refused}");
        let order: Vec<u32> = vec![2, 0, 4, 1, 3];
        let ordered = game.act(A::OrderTriggers { order }).expect("ordered");
        (triggers, ordered)
    });
    assert_eq!(asked.len(), 5);
    assert!(asked.iter().all(|t| t.text.is_some()), "{asked:?}");
    // Each resolves, the last placed first (CR 405.3): Test Shrine n gains n life.
    let gains: Vec<i32> = ordered
        .happened
        .iter()
        .filter_map(|h| match h {
            H::Life { amount, .. } if *amount > 0 => Some(*amount),
            _ => None,
        })
        .collect();
    let shrine = |i: usize| -> i32 {
        asked[i]
            .name
            .trim_start_matches("Test Shrine ")
            .parse()
            .unwrap()
    };
    let want: Vec<i32> = [3, 1, 4, 0, 2].iter().map(|i| shrine(*i)).collect();
    assert_eq!(gains, want, "{:?}", ordered.happened);
}

/// Issue #1745: Krark's Thumb's two flips are shown, and the one kept is the reader's pick.
#[test]
fn a_coin_flip_kept_shows_the_flips() {
    let (asked, refused) = engine(|| {
        let thumb = card(
            "Krark's Thumb",
            Some("{2}"),
            "Legendary Artifact",
            "If you would flip a coin, instead flip two coins and ignore one.",
            1,
        );
        let flip = card(
            "Test Toss",
            Some("{G}"),
            "Sorcery",
            "Flip a coin. If you win the flip, draw a card.",
            1,
        );
        let mut game = kept(&deck(vec![thumb, flip]));
        put(&mut game, "Krark's Thumb", Place::Battlefield);
        put(&mut game, "Forest", Place::Battlefield);
        let mut step = cast(&mut game, "Test Toss");
        for _ in 0..4 {
            if step
                .view
                .prompt
                .as_ref()
                .is_some_and(|p| p.results.is_some())
            {
                break;
            }
            step = if step.view.prompt.is_some() {
                answer_until(&mut game, step, 1, |_| false, &[])
            } else {
                game.act(A::Pass).expect("resolve it")
            };
        }
        let asked = step
            .view
            .prompt
            .as_ref()
            .and_then(|p| p.results.clone())
            .unwrap_or_else(|| panic!("{:?}", step.view.prompt));
        let refused = game
            .act(A::KeepResults {
                indices: vec![0, 1],
            })
            .unwrap_err();
        game.act(A::KeepResults { indices: vec![1] })
            .expect("kept the second");
        (asked, refused)
    });
    assert!(!asked.dice);
    assert_eq!(asked.results.len(), 2);
    assert!(asked.results.iter().all(|r| *r <= 1));
    assert_eq!(asked.count, 1);
    assert!(refused.contains("Keep 1 flip"), "{refused}");
}

/// Issue #1751: a search that splits its finds between zones — Cultivate's "put one onto the
/// battlefield tapped and the other into your hand" — is asked as a split pick, the picked card
/// onto the battlefield and the rest into the hand, never the generic options.
#[test]
fn a_search_that_splits_its_finds_asks_which_goes_onto_the_battlefield() {
    let (split, done) = engine(|| {
        let cultivate = card(
            "Cultivate",
            Some("{2}{G}"),
            "Sorcery",
            "Search your library for up to two basic land cards, reveal those cards, put one onto the battlefield tapped and the other into your hand, then shuffle.",
            1,
        );
        let mut game = kept(&deck(vec![cultivate]));
        let id = find(
            &put(&mut game, "Cultivate", Place::Hand).view.you.hand,
            "Cultivate",
        )
        .unwrap()
        .id;
        let asked = game
            .act(A::Play { id })
            .expect("cast unpaid in the sandbox");
        let search = asked
            .view
            .prompt
            .as_ref()
            .and_then(|p| p.pick.clone())
            .unwrap_or_else(|| panic!("a search: {:?}", asked.view.prompt));
        assert_eq!(search.purpose, PlaytestPickPurpose::Search);
        let forests: Vec<u64> = search
            .cards
            .iter()
            .filter(|c| c.name == "Forest")
            .take(2)
            .map(|c| c.id)
            .collect();
        assert_eq!(forests.len(), 2, "two Forests to find");
        let found = game
            .act(A::PickCards {
                ids: forests.clone(),
            })
            .expect("found two");
        let split = found
            .view
            .prompt
            .as_ref()
            .and_then(|p| p.pick.clone())
            .unwrap_or_else(|| panic!("a split: {:?}", found.view.prompt));
        let done = game
            .act(A::PickCards {
                ids: vec![forests[0]],
            })
            .expect("split");
        (split, done)
    });
    assert_eq!(split.purpose, PlaytestPickPurpose::Split);
    assert_eq!((split.min, split.max), (1, 1));
    assert_eq!(split.cards.len(), 2);
    assert!(done.view.prompt.is_none(), "{:?}", done.view.prompt);
    let lands: Vec<&GameCard> = done
        .view
        .you
        .battlefield
        .iter()
        .filter(|c| c.name == "Forest")
        .collect();
    assert_eq!(lands.len(), 1, "one Forest onto the battlefield");
    assert!(lands[0].tapped, "tapped, as Cultivate says");
    assert!(
        done.view.you.hand.iter().any(|c| c.name == "Forest"),
        "the other into the hand"
    );
}

/// The reader's own spell on the stack, with an instant in hand they could cast: held, they stop
/// over it (`setHold`, issue #1751) and may pass to let it resolve; not held, it resolves.
#[test]
fn holding_priority_stops_the_reader_over_their_own_spell() {
    fn cast_bears(hold: bool) -> (PlaytestStep, Option<PlaytestStep>) {
        engine(move || {
            let growth = card(
                "Giant Growth",
                Some("{G}"),
                "Instant",
                "Target creature gets +3/+3 until end of turn.",
                1,
            );
            let mut game = kept(&deck(vec![growth]));
            for _ in 0..3 {
                put(&mut game, "Forest", Place::Battlefield);
            }
            put(&mut game, "Grizzly Bears", Place::Battlefield);
            put(&mut game, "Giant Growth", Place::Hand);
            let bears = find(
                &put(&mut game, "Grizzly Bears", Place::Hand).view.you.hand,
                "Grizzly Bears",
            )
            .unwrap()
            .id;
            let set = game.act(A::SetHold { on: hold }).expect("a setting");
            assert_eq!(set.view.hold, hold);
            let cast = game
                .act(A::Play { id: bears })
                .expect("cast from the Forests");
            let passed =
                (cast.view.stage == Stage::Respond).then(|| game.act(A::Pass).expect("pass"));
            (cast, passed)
        })
    }
    let (cast, passed) = cast_bears(false);
    assert_eq!(cast.view.stage, Stage::Main, "not held: it resolves");
    assert!(cast.view.stack.is_empty());
    assert!(passed.is_none());

    let (cast, passed) = cast_bears(true);
    assert_eq!(
        cast.view.stage,
        Stage::Respond,
        "held over the reader's own spell"
    );
    assert_eq!(cast.view.stack.len(), 1);
    assert_eq!(cast.view.stack[0].name, "Grizzly Bears");
    let passed = passed.expect("passed");
    assert!(passed.view.stack.is_empty(), "passing lets it resolve");
    assert_eq!(
        passed
            .view
            .you
            .battlefield
            .iter()
            .filter(|c| c.name == "Grizzly Bears")
            .count(),
        2
    );
}

/// Who plays first is the reader's to pick (issue #1751): on the draw against the goldfish, the
/// goldfish takes the first turn; on the play against the AI the reader does, whatever the coin
/// flip would have said.
#[test]
fn who_plays_first_is_picked() {
    use super::session::OpponentDeck;
    use super::view::{PlaytestFirst, PlaytestPlayer};
    let (fish_random, fish_draw, ai_coin, ai_play, ai_draw) = engine(|| {
        let mine = deck(vec![]);
        let theirs = [OpponentDeck {
            cards: deck(vec![]),
            tokens: vec![],
            person: false,
        }];
        let started = |opponents: &[OpponentDeck], seed: u64, first: PlaytestFirst| {
            Playtest::new_first(&mine, &[], opponents, seed, Difficulty::VeryEasy, first)
                .expect("a game")
                .1
                .view
                .started
        };
        (
            started(&[], 1, PlaytestFirst::Random),
            started(&[], 1, PlaytestFirst::Draw),
            started(&theirs, 1, PlaytestFirst::Random),
            started(&theirs, 1, PlaytestFirst::Play),
            started(&theirs, 2, PlaytestFirst::Draw),
        )
    });
    assert_eq!(
        fish_random,
        PlaytestPlayer::You,
        "the goldfish's coin flip is the reader"
    );
    assert_eq!(fish_draw, PlaytestPlayer::Opponent);
    assert_eq!(
        ai_coin,
        PlaytestPlayer::Opponent,
        "an odd seed: the opponent"
    );
    assert_eq!(ai_play, PlaytestPlayer::You);
    assert_eq!(ai_draw, PlaytestPlayer::Opponent);
}

/// Issue #1746: phase's game menu offers Concede (CR 104.3a), always legal though never among
/// the legal answers. Against the goldfish — which nobody can lose to otherwise — it ends the
/// game as the reader's loss, and once it is over there is nothing left to concede.
#[test]
fn conceding_to_the_goldfish_ends_the_game_as_a_loss() {
    let (step, again) = engine(|| {
        let mut game = kept(&deck(vec![]));
        let step = game.act(A::Concede).expect("conceded");
        let again = game.act(A::Concede).unwrap_err();
        (step, again)
    });
    assert_eq!(step.view.stage, Stage::Over);
    assert_eq!(
        step.view.winner,
        Some(super::view::PlaytestPlayer::Opponent),
        "the goldfish wins"
    );
    assert!(
        step.happened
            .iter()
            .any(|h| matches!(h, H::GameOver { winner: Some(_) })),
        "{:?}",
        step.happened
    );
    assert!(
        step.view.specials.is_empty(),
        "nothing is offered once over"
    );
    assert!(again.contains("over"), "{again}");
}

/// Concede is taken at the opening hand too: the game is unfinished.
#[test]
fn a_concession_is_taken_before_the_keep() {
    let step = engine(|| {
        let (mut game, _) =
            Playtest::new(&deck(vec![]), &[], &[], 7, Difficulty::default()).expect("a game");
        game.act(A::Concede).expect("conceded at the opening hand")
    });
    assert_eq!(step.view.stage, Stage::Over);
}

/// Issue #1746: an action of the rules' that belongs to no card — paying to end a Licid's effect
/// (CR 116.2c) — is offered beside Pass (`specials`), with the card's name and the cost as the
/// engine gives them, and taken by `special`; the reader keeps priority after it (CR 116.1).
#[test]
fn a_licids_effect_is_ended_by_a_special_action() {
    let (before, offered, after, refused) = engine(|| {
        let licid = card(
            "Tempting Licid",
            Some("{2}{G}"),
            "Creature — Licid",
            "{G}, {T}: Tempting Licid loses this ability and becomes an Aura enchantment with enchant creature. Attach it to target creature. You may pay {G} to end this effect.\nAll creatures able to block enchanted creature do so.",
            1,
        );
        let mut game = kept(&deck(vec![licid]));
        for _ in 0..3 {
            put(&mut game, "Forest", Place::Battlefield);
        }
        put(&mut game, "Grizzly Bears", Place::Battlefield);
        put(&mut game, "Tempting Licid", Place::Battlefield);
        // A turn round, so the Licid is no longer summoning sick.
        game.act(A::EndTurn).expect("the goldfish's turn");
        let before = game.view();
        let licid = find(&before.you.battlefield, "Tempting Licid")
            .expect("the Licid")
            .id;
        let mut step = game.act(A::Activate { id: licid }).expect("activated");
        // Its target, and then the ability on the stack: let it resolve.
        for _ in 0..6 {
            match step.view.stage {
                Stage::Prompt => {
                    let bears = step
                        .view
                        .prompt
                        .as_ref()
                        .and_then(|p| {
                            p.options
                                .iter()
                                .find(|o| o.cards.iter().any(|c| c.name == "Grizzly Bears"))
                        })
                        .map(|o| o.index)
                        .unwrap_or(0);
                    step = game.act(A::Choose { index: bears }).expect("aimed");
                }
                Stage::Respond => step = game.act(A::Pass).expect("resolved"),
                _ => break,
            }
        }
        let offered = step.view.clone();
        let index = offered
            .specials
            .iter()
            .find(|o| o.kind == "EndContinuousEffect")
            .map(|o| o.index)
            .expect("ending the effect is offered");
        let after = game.act(A::Special { index }).expect("ended");
        let refused = game.act(A::Special { index: 9 }).unwrap_err();
        (before, offered, after, refused)
    });
    assert!(before.specials.is_empty(), "no effect to end yet");
    let special = offered
        .specials
        .iter()
        .find(|o| o.kind == "EndContinuousEffect")
        .unwrap();
    assert_eq!(special.label.as_deref(), Some("Tempting Licid"));
    assert_eq!(special.cost.as_deref(), Some("{G}"));
    assert!(
        !offered.specials.iter().any(|o| o.kind == "PassPriority"),
        "passing is the foot's own button"
    );
    assert_eq!(after.view.stage, offered.stage, "the reader keeps priority");
    assert!(
        after
            .view
            .specials
            .iter()
            .all(|o| o.kind != "EndContinuousEffect"),
        "the effect is over"
    );
    assert!(!refused.is_empty());
}
