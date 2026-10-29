//! A lobby's game (issue #1419): a person in an opponent's seat, deciding from their own app.
//! The host's app holds the one game; each guest is sent the view from their own seat and what
//! they may see, and acts on their own decisions only. Every test runs on the engine's stack.

use std::collections::HashSet;

use super::session::{OpponentDeck, Playtest};
use super::tests::{engine, green, red};
use super::view::{
    Difficulty, PlaytestAction as A, PlaytestHappened as H, PlaytestPlayer, PlaytestStage as Stage,
    PlaytestStep, PlaytestView,
};

const RED: [&str; 4] = ["Mountain", "Raging Goblin", "Hill Giant", "Lightning Bolt"];
const GREEN: [&str; 4] = ["Forest", "Grizzly Bears", "Llanowar Elves", "Giant Growth"];

fn person(cards: Vec<crate::cards::CardFacts>) -> OpponentDeck {
    OpponentDeck {
        cards,
        tokens: Vec::new(),
        person: true,
    }
}

fn ai(cards: Vec<crate::cards::CardFacts>) -> OpponentDeck {
    OpponentDeck {
        person: false,
        ..person(cards)
    }
}

/// The reader's green deck against a guest's red one, and the guest's first step.
fn duel(seed: u64) -> (Playtest, PlaytestStep, PlaytestStep) {
    let (mut game, host) =
        Playtest::new(&green(), &[], &[person(red())], seed, Difficulty::VeryEasy)
            .expect("a game starts");
    let mut guests = game.guest_steps();
    assert_eq!(guests.len(), 1, "one guest, one step");
    let (seat, guest) = guests.remove(0);
    assert_eq!(seat, 1);
    (game, host, guest)
}

fn names(view: &PlaytestView) -> HashSet<String> {
    view.you.hand.iter().map(|c| c.name.clone()).collect()
}

/// What a person at the table does with the stage they are at: the first thing on offer.
fn next(stage: Stage) -> A {
    match stage {
        Stage::Mulligan => A::Keep { bottom: vec![] },
        Stage::Main => A::EndTurn,
        Stage::Attack => A::Attack { attacks: vec![] },
        Stage::Block => A::Block { blocks: vec![] },
        Stage::Respond => A::Pass,
        Stage::Prompt => A::Auto,
        Stage::Waiting | Stage::Watching | Stage::Over => {
            unreachable!("nothing to do at {stage:?}")
        }
    }
}

/// Play on, each person taking the first thing on offer when the game waits on them, until the
/// game reaches `turn` (or ends). Answers every step the reader and the guest at seat 1 were
/// sent, in order.
fn play_to(
    game: &mut Playtest,
    mut guest: PlaytestView,
    turn: u32,
) -> (Vec<PlaytestStep>, Vec<PlaytestStep>) {
    let mut hosts = Vec::new();
    let mut guests = Vec::new();
    for _ in 0..600 {
        let host = game.view();
        if host.stage == Stage::Over || host.turn >= turn {
            break;
        }
        let step = if host.stage == Stage::Waiting {
            assert_ne!(guest.stage, Stage::Waiting, "someone decides");
            game.act_by(1, next(guest.stage)).expect("the guest acts")
        } else {
            game.act(next(host.stage)).expect("the reader acts")
        };
        hosts.push(step);
        for (seat, step) in game.guest_steps() {
            if seat == 1 {
                guest = step.view.clone();
                guests.push(step);
            }
        }
    }
    (hosts, guests)
}

#[test]
fn each_person_is_sent_the_table_from_their_own_seat() {
    let (host, guest) = engine(|| {
        let (_, host, guest) = duel(4);
        (host, guest)
    });
    assert!(host.view.lobby && guest.view.lobby);
    assert!(
        !host.view.can_undo && !host.view.sandbox,
        "no undo, no sandbox together"
    );
    // The guest is `you` in their own view, with their own hand; the reader is their opponent.
    assert_eq!(guest.view.you.hand.len(), 7);
    assert!(names(&guest.view).iter().all(|n| RED.contains(&n.as_str())));
    assert!(names(&host.view)
        .iter()
        .all(|n| GREEN.contains(&n.as_str())));
    assert_eq!(guest.view.opponents.len(), 1);
    assert_eq!(guest.view.opponents[0].player, PlaytestPlayer::Opponent);
    assert!(
        guest.view.opponents[0].hand.is_empty(),
        "the reader's hand is a count"
    );
    assert_eq!(guest.view.opponents[0].hand_count, 7);
    assert!(
        host.view.opponents[0].hand.is_empty(),
        "and so is the guest's"
    );
    assert!(guest.view.opponents[0].library_cards.is_empty());
    assert!(
        guest.frames.is_empty(),
        "a guest is sent the settled view alone"
    );
    // The opening hands: each person decides theirs, or waits on the other who does.
    for view in [&host.view, &guest.view] {
        assert!(matches!(view.stage, Stage::Mulligan | Stage::Waiting));
        if view.stage == Stage::Waiting {
            assert_eq!(view.deciding, Some(PlaytestPlayer::Opponent));
        } else {
            assert_eq!(view.deciding, None);
        }
    }
    assert!(host.view.stage == Stage::Mulligan || guest.view.stage == Stage::Mulligan);
}

#[test]
fn nothing_is_taken_back_and_the_sandbox_stays_off_together() {
    let refusals = engine(|| {
        let (mut game, _, _) = duel(4);
        let before = game.view();
        let refused = [
            game.act(A::Undo).unwrap_err(),
            game.act(A::SetSandbox { on: true }).unwrap_err(),
            game.act_by(1, A::Redo).unwrap_err(),
            game.act_by(2, A::Pass).unwrap_err(),
        ];
        assert_eq!(game.view(), before, "a refusal changes nothing");
        refused
    });
    assert!(refusals[0].contains("cannot be taken back"));
    assert!(refusals[1].contains("sandbox"));
    assert!(refusals[2].contains("cannot be taken back"));
    assert!(refusals[3].contains("not a person's"), "{}", refusals[3]);
}

#[test]
fn a_person_acts_only_on_their_own_decision_and_a_refusal_changes_nothing_for_anyone() {
    let (refusal, host_before, host_after, guest_before, guest_after) = engine(|| {
        let (mut game, _, guest) = duel(4);
        // Both keep, whichever decides first; then whoever waits tries to act anyway.
        let (_, _) = play_to(&mut game, guest.view, 1);
        let host = game.view();
        let waiting = if host.stage == Stage::Waiting { 0 } else { 1 };
        let guest_before = game.view_of(1).unwrap();
        let refusal = game.act_by(waiting, A::EndTurn).unwrap_err();
        (
            refusal,
            host,
            game.view(),
            guest_before,
            game.view_of(1).unwrap(),
        )
    });
    assert!(refusal.contains("Another player is deciding"), "{refusal}");
    assert_eq!(host_before, host_after);
    assert_eq!(guest_before, guest_after);
}

#[test]
fn the_game_plays_on_between_two_people_and_each_is_told_only_what_they_may_see() {
    let (hosts, guests, host, guest) = engine(|| {
        let (mut game, _, guest) = duel(6);
        let (hosts, guests) = play_to(&mut game, guest.view, 6);
        let host = game.view();
        let guest = game.view_of(1).unwrap();
        (hosts, guests, host, guest)
    });
    assert!(
        host.turn >= 6 || host.stage == Stage::Over,
        "the game got going"
    );
    // Both people took turns: each saw a turn of their own and one of the other's begin.
    let turns = |steps: &[PlaytestStep], seat| {
        steps
            .iter()
            .flat_map(|s| &s.happened)
            .filter(|h| matches!(h, H::TurnBegan { seat: s, .. } if *s == seat))
            .count()
    };
    for steps in [&hosts, &guests] {
        assert!(turns(steps, PlaytestPlayer::You) >= 2);
        assert!(turns(steps, PlaytestPlayer::Opponent) >= 2);
    }
    // A draw is named to the one who drew it, and to no one else.
    for (steps, mine) in [(&hosts, GREEN), (&guests, RED)] {
        for h in steps.iter().flat_map(|s| &s.happened) {
            if let H::Drew { seat, name } = h {
                match seat {
                    PlaytestPlayer::You => {
                        assert!(name.as_deref().is_some_and(|n| mine.contains(&n)), "{h:?}")
                    }
                    _ => assert_eq!(name, &None, "an opponent's draw is never named"),
                }
            }
        }
    }
    // The reader's replay frames are the reader's: their own hand, never the guest's.
    for frame in hosts.iter().flat_map(|s| &s.frames) {
        assert!(names(&frame.view)
            .iter()
            .all(|n| GREEN.contains(&n.as_str())));
        assert!(frame.view.opponents[0].hand.is_empty());
    }
    assert!(guests.iter().all(|s| s.frames.is_empty()));
    // The two views agree on the table, each from its own side.
    assert_eq!(host.you.life, guest.opponents[0].life);
    assert_eq!(host.opponents[0].life, guest.you.life);
    assert_eq!(host.you.hand.len() as u32, guest.opponents[0].hand_count);
    assert_eq!(guest.you.hand.len() as u32, host.opponents[0].hand_count);
    assert_eq!(host.turn, guest.turn);
    let flip = |p: PlaytestPlayer| match p {
        PlaytestPlayer::You => PlaytestPlayer::Opponent,
        _ => PlaytestPlayer::You,
    };
    assert_eq!(flip(host.active), guest.active);
}

#[test]
fn a_guest_at_a_four_player_table_sees_the_others_in_turn_order_after_their_own_seat() {
    let (host, guest) = engine(|| {
        let opponents = [person(red()), ai(red()), ai(green())];
        let (mut game, _) = Playtest::new(&green(), &[], &opponents, 8, Difficulty::VeryEasy)
            .expect("a game starts");
        assert_eq!(game.guests(), vec![1]);
        let guest = game.guest_steps().remove(0).1.view;
        (game.view(), guest)
    });
    assert_eq!(guest.opponents.len(), 3);
    let order: Vec<PlaytestPlayer> = guest.opponents.iter().map(|s| s.player).collect();
    assert_eq!(
        order,
        [
            PlaytestPlayer::Opponent,
            PlaytestPlayer::Opponent2,
            PlaytestPlayer::Opponent3
        ]
    );
    // Seat 1's opponents are seats 2, 3 and 0: the reader is the last of them.
    assert_eq!(guest.opponents[2].hand_count, host.you.hand.len() as u32);
    assert_eq!(guest.opponents[0].hand_count, host.opponents[1].hand_count);
    assert!(names(&guest).iter().all(|n| RED.contains(&n.as_str())));
}

#[test]
fn a_guest_handed_to_the_ai_is_played_by_it_and_the_game_plays_on() {
    let (guests, view, again) = engine(|| {
        let (mut game, _, guest) = duel(4);
        let _ = play_to(&mut game, guest.view, 2);
        game.hand_to_ai(1).expect("the seat is the AI's");
        let guests = game.guests();
        let view = game.view();
        // Nothing waits on a person who has gone: the game comes back to the reader alone.
        let mut step = game.act(next(view.stage)).expect("the reader plays on");
        for _ in 0..80 {
            if step.view.turn >= 5 || step.view.stage == Stage::Over {
                break;
            }
            step = game
                .act(next(step.view.stage))
                .expect("the reader plays on");
        }
        (guests, view, step.view)
    });
    assert!(guests.is_empty());
    assert_ne!(
        view.stage,
        Stage::Waiting,
        "the AI took the guest's decision"
    );
    assert!(!view.lobby, "the reader is the only person left");
    assert!(again.turn >= 5 || again.stage == Stage::Over);
}

#[test]
fn the_reader_s_seat_is_never_handed_to_the_ai() {
    let refused = engine(|| {
        let (mut game, _, _) = duel(4);
        game.hand_to_ai(0).unwrap_err()
    });
    assert!(refused.contains("not a person's"));
}
