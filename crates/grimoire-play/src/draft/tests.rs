//! Drafts end to end on the engine's stack: a quick draft against seven bots to its last pick,
//! a sealed pool, a cube, a pod that waits for its people, a bot taking a seat, refusals that
//! change nothing, and a snapshot that resumes where it left off; a Commander draft two cards a
//! pick; Winston drafts against a bot and between two people, every card ending in a pool and no
//! seat ever shown a pile it is not deciding on. Boosters are 14 cards (20 for Commander) dealt by
//! a seeded die from 35 cards of five colours, so every run is the same.

use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;

use crate::cards::CardFacts;
use crate::{on_engine_stack, Difficulty};

use super::{
    Draft, DraftCardFacts, DraftMode, DraftSeatSetup, DraftSetup, DraftStatus, DraftView, PodFormat,
};

fn engine<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> T {
    on_engine_stack(work).expect("the engine ran")
}

fn card(
    name: &str,
    cost: Option<&str>,
    type_line: &str,
    text: &str,
    pt: Option<(&str, &str)>,
    color: Option<&str>,
    rarity: &str,
) -> DraftCardFacts {
    DraftCardFacts {
        card: CardFacts {
            card_id: format!("print-{}", name.to_lowercase().replace([' ', ','], "-")),
            name: name.into(),
            quantity: 1,
            mana_cost: cost.map(Into::into),
            type_line: Some(type_line.into()),
            oracle_text: Some(text.into()),
            power: pt.map(|p| p.0.into()),
            toughness: pt.map(|p| p.1.into()),
            cmc: Some(cost.map_or(0.0, |c| c.matches('{').count() as f64)),
            layout: Some("normal".into()),
            colors: color.map(|c| vec![c.to_string()]).unwrap_or_default(),
            color_identity: color.map(|c| vec![c.to_string()]).unwrap_or_default(),
            ..CardFacts::default()
        },
        set_code: "tst".into(),
        collector_number: "1".into(),
        rarity: rarity.into(),
    }
}

/// Seven cards of each colour — a curve of bodies, a flyer and a spell — and none colourless.
fn cards() -> Vec<DraftCardFacts> {
    let mut all = Vec::new();
    for (c, word) in [
        ("W", "Plains"),
        ("U", "Island"),
        ("B", "Swamp"),
        ("R", "Mountain"),
        ("G", "Forest"),
    ] {
        let pip = format!("{{{c}}}");
        let colour = Some(c);
        all.extend([
            card(
                &format!("{word} Scout"),
                Some(&pip),
                "Creature — Human Scout",
                "",
                Some(("1", "1")),
                colour,
                "common",
            ),
            card(
                &format!("{word} Bear"),
                Some(&format!("{{1}}{pip}")),
                "Creature — Bear",
                "",
                Some(("2", "2")),
                colour,
                "common",
            ),
            card(
                &format!("{word} Soldier"),
                Some(&format!("{{2}}{pip}")),
                "Creature — Human Soldier",
                "",
                Some(("3", "3")),
                colour,
                "common",
            ),
            card(
                &format!("{word} Flyer"),
                Some(&format!("{{2}}{pip}")),
                "Creature — Bird",
                "Flying",
                Some(("2", "2")),
                colour,
                "uncommon",
            ),
            card(
                &format!("{word} Giant"),
                Some(&format!("{{4}}{pip}")),
                "Creature — Giant",
                "",
                Some(("5", "5")),
                colour,
                "uncommon",
            ),
            card(
                &format!("{word} Angel"),
                Some(&format!("{{3}}{pip}{pip}")),
                "Creature — Angel",
                "Flying",
                Some(("4", "4")),
                colour,
                "rare",
            ),
            card(
                &format!("{word} Dragon"),
                Some(&format!("{{4}}{pip}{pip}")),
                "Creature — Dragon",
                "Flying",
                Some(("6", "6")),
                colour,
                "mythic",
            ),
        ]);
    }
    all
}

/// `[seat][round]` boosters of `size` printings, dealt by a seeded die.
fn boosters(seats: usize, rounds: usize, size: usize, seed: u64) -> Vec<Vec<Vec<String>>> {
    let ids: Vec<String> = cards().into_iter().map(|c| c.card.card_id).collect();
    let mut rng = ChaCha8Rng::seed_from_u64(seed);
    (0..seats)
        .map(|_| {
            (0..rounds)
                .map(|_| {
                    (0..size)
                        .map(|_| ids[rng.random_range(0..ids.len())].clone())
                        .collect()
                })
                .collect()
        })
        .collect()
}

fn person(name: &str) -> DraftSeatSetup {
    DraftSeatSetup {
        name: name.into(),
        bot: false,
        peer: None,
    }
}

fn bots(n: usize) -> Vec<DraftSeatSetup> {
    (1..=n)
        .map(|i| DraftSeatSetup {
            name: format!("Bot {i}"),
            bot: true,
            peer: None,
        })
        .collect()
}

fn setup(
    mode: DraftMode,
    seats: Vec<DraftSeatSetup>,
    rounds: usize,
    difficulty: Difficulty,
) -> DraftSetup {
    let packs = boosters(seats.len(), rounds, 14, 7);
    DraftSetup {
        mode,
        difficulty,
        seed: 42,
        label: "Test Set".into(),
        seats,
        packs,
        pack_sets: vec!["tst".into(); rounds],
        min_deck_size: 40,
        pod_format: PodFormat::Booster,
    }
}

/// You and seven bots, three rounds.
fn quick(difficulty: Difficulty) -> DraftSetup {
    let mut seats = vec![person("You")];
    seats.extend(bots(7));
    setup(DraftMode::Quick, seats, 3, difficulty)
}

/// Two people from a lobby and six bots, three rounds.
fn pod() -> DraftSetup {
    let mut seats = vec![person("Host"), person("Guest")];
    seats[1].peer = Some("p1".into());
    seats.extend(bots(6));
    setup(DraftMode::Pod, seats, 3, Difficulty::VeryEasy)
}

fn start(setup: DraftSetup) -> Draft {
    Draft::new(setup, cards()).expect("a draft starts")
}

/// The first card of `view`'s pack.
fn first(view: &DraftView) -> Vec<String> {
    vec![view.pack[0].instance_id.clone()]
}

/// Pick the first card of seat 0's pack until the draft is over; how many picks it took.
fn draft_out(draft: &mut Draft) -> usize {
    let mut picks = 0;
    while draft.status() == DraftStatus::Drafting {
        let view = draft.view(0);
        assert!(!view.waiting, "a quick draft never waits on its bots");
        assert_eq!(
            view.pack.len(),
            usize::from(view.pack_size - view.pick_number)
        );
        draft.pick(0, first(&view)).expect("the pick is taken");
        picks += 1;
        assert!(picks <= 42, "the draft ends after 42 picks");
    }
    picks
}

#[test]
fn a_quick_draft_runs_to_deckbuilding() {
    engine(|| {
        let mut draft = start(quick(Difficulty::Medium));
        let db = draft
            .db
            .as_ref()
            .expect("the evaluating bots read the draft's cards");
        assert!(db.get_face_by_name("Forest Dragon").is_some());
        let view = draft.view(0);
        assert_eq!(view.status, DraftStatus::Drafting);
        assert_eq!((view.pack_number, view.pack_count), (0, 3));
        assert_eq!((view.pick_number, view.pack_size), (0, 14));
        assert!(view.pass_left);
        assert_eq!(view.seats.len(), 8);
        // The bots picked from their first boosters with the reader.
        assert!(view.seats[1..].iter().all(|s| s.bot && s.picked));
        let instance = &view.pack[0];
        assert!(instance
            .instance_id
            .starts_with(&format!("{}#0.0.", instance.card_id)));
        assert_eq!(instance.set_code, "tst");

        draft.pick(0, first(&view)).unwrap();
        let view = draft.view(0);
        assert_eq!((view.pick_number, view.pack.len()), (1, 13));
        // The pack came from the seat on the right: passed left.
        assert!(view.pack[0].instance_id.contains("#7.0."));

        assert_eq!(draft_out(&mut draft), 41);
        assert_eq!(draft.status(), DraftStatus::Deckbuilding);
        let view = draft.view(0);
        assert!(view.pack.is_empty() && !view.waiting);
        assert_eq!(view.pool.len(), 42);
        assert_eq!(draft.pool(0).len(), 42);
        for seat in 1..8 {
            assert_eq!(draft.pool(seat).len(), 42, "bot {seat}'s pool");
            assert_eq!(view.seats[usize::from(seat)].pool_count, 42);
        }
        assert!(draft.pick(0, vec!["anything".into()]).is_err());
    });
}

#[test]
fn rounds_pass_left_right_left() {
    engine(|| {
        let mut draft = start(quick(Difficulty::Easy));
        let mut directions = Vec::new();
        while draft.status() == DraftStatus::Drafting {
            let view = draft.view(0);
            if view.pick_number == 0 {
                directions.push(view.pass_left);
            }
            draft.pick(0, first(&view)).unwrap();
        }
        assert_eq!(directions, vec![true, false, true]);
    });
}

#[test]
fn a_refused_pick_changes_nothing() {
    engine(|| {
        let mut draft = start(quick(Difficulty::VeryEasy));
        let before = draft.snapshot();
        let view = draft.view(0);

        assert!(draft.pick(0, vec!["no-such-card#0.0.0".into()]).is_err());
        assert!(draft
            .pick(
                0,
                vec![
                    view.pack[0].instance_id.clone(),
                    view.pack[1].instance_id.clone()
                ]
            )
            .is_err());
        assert!(draft.pick(0, Vec::new()).is_err());
        // A bot's seat is not a person's to pick for, nor a seat the table does not have.
        assert!(draft.pick(1, first(&view)).is_err());
        assert!(draft.pick(9, first(&view)).is_err());
        assert_eq!(draft.snapshot(), before);
    });
}

#[test]
fn pick_for_me_picks_as_a_bot_would() {
    engine(|| {
        let mut draft = start(quick(Difficulty::Medium));
        draft.auto_pick(0).expect("the bot's choice is taken");
        let view = draft.view(0);
        assert_eq!(view.pool.len(), 1);
        assert_eq!(view.pick_number, 1);
        assert!(draft.auto_pick(3).is_err(), "seat 3 is a bot's");

        // Rare and mythic first, as an `Easy` bot picks.
        let mut easy = start(quick(Difficulty::Easy));
        let pack = easy.view(0).pack;
        easy.auto_pick(0).unwrap();
        let best = pack.iter().map(|c| rank(&c.rarity)).max().unwrap();
        assert_eq!(rank(&easy.view(0).pool[0].rarity), best);
    });
}

fn rank(rarity: &str) -> u8 {
    ["common", "uncommon", "rare", "mythic"]
        .iter()
        .position(|r| *r == rarity)
        .unwrap() as u8
}

#[test]
fn sealed_opens_six_boosters_into_the_pool() {
    engine(|| {
        let setup = setup(
            DraftMode::Sealed,
            vec![person("You")],
            6,
            Difficulty::Medium,
        );
        let opened: Vec<String> = setup.packs[0].concat();
        let mut draft = start(setup);
        assert_eq!(draft.status(), DraftStatus::Deckbuilding);
        assert_eq!(draft.pool(0), opened);
        let view = draft.view(0);
        assert_eq!(view.pool.len(), 84);
        assert!(view.pack.is_empty() && !view.waiting);
        assert_eq!(view.pack_count, 6);
        // phase's second seat, which sealed needs, is never shown.
        assert_eq!(view.seats.len(), 1);
        assert!(draft
            .pick(0, vec![view.pool[0].instance_id.clone()])
            .is_err());
        assert!(draft.auto_pick(0).is_err());

        let short = setup_sealed_short();
        assert!(Draft::new(short, cards()).is_err(), "sealed opens six");
    });
}

fn setup_sealed_short() -> DraftSetup {
    setup(
        DraftMode::Sealed,
        vec![person("You")],
        3,
        Difficulty::VeryEasy,
    )
}

#[test]
fn a_cube_seats_any_table() {
    engine(|| {
        let mut seats = vec![person("You")];
        seats.extend(bots(2));
        let mut setup = setup(DraftMode::Cube, seats, 3, Difficulty::Hard);
        setup.packs = boosters(3, 3, 5, 9);
        setup.pack_sets = vec![String::new(); 3];
        let mut draft = start(setup);
        let view = draft.view(0);
        assert_eq!(view.pack_size, 5);
        assert_eq!(view.pack[0].set_code, "tst");
        let mut picks = 0;
        while draft.status() == DraftStatus::Drafting {
            draft.pick(0, first(&draft.view(0))).unwrap();
            picks += 1;
        }
        assert_eq!(picks, 15);
        assert!((0..3).all(|seat| draft.pool(seat).len() == 15));
    });
}

#[test]
fn a_draft_from_sets_needs_two_seats() {
    engine(|| {
        let alone = setup(
            DraftMode::Quick,
            vec![person("You")],
            3,
            Difficulty::VeryEasy,
        );
        assert!(Draft::new(alone, cards()).is_err());
    });
}

#[test]
fn a_pod_waits_for_every_person() {
    engine(|| {
        let mut draft = start(pod());
        let host = draft.view(0);
        assert!(!host.waiting);
        assert_eq!(host.pack.len(), 14);

        draft.pick(0, first(&host)).unwrap();
        let host = draft.view(0);
        assert!(host.waiting, "the guest has not picked");
        assert!(host.pack.is_empty());
        assert_eq!(host.pool.len(), 1);
        assert!(host.seats[0].picked && !host.seats[1].picked);
        assert!(host.seats[2..].iter().all(|s| s.picked));

        // Picking again while waiting is refused, and changes nothing.
        let before = draft.snapshot();
        assert!(draft.auto_pick(0).is_err());
        assert!(draft.pick(0, vec!["x#0.0.0".to_string()]).is_err());
        assert_eq!(draft.snapshot(), before);

        let guest = draft.view(1);
        assert!(!guest.waiting);
        assert_eq!(guest.pack.len(), 14);
        draft.pick(1, first(&guest)).unwrap();

        let host = draft.view(0);
        assert!(!host.waiting);
        assert_eq!((host.pick_number, host.pack.len()), (1, 13));
        // The bots have picked from the next packs already; the people have not.
        assert!(!host.seats[0].picked && !host.seats[1].picked);
        assert!(host.seats[2..].iter().all(|s| s.picked));
    });
}

#[test]
fn a_bot_takes_the_seat_of_a_person_who_left() {
    engine(|| {
        let mut draft = start(pod());
        draft.set_connected(1, false);
        assert!(!draft.view(0).seats[1].connected);
        draft.set_connected(4, false);
        assert!(
            draft.view(0).seats[4].connected,
            "a bot is always on the line"
        );

        draft.pick(0, first(&draft.view(0))).unwrap();
        assert!(draft.view(0).waiting);
        draft.replace_with_bot(1).unwrap();
        let host = draft.view(0);
        assert!(!host.waiting, "the bot picked for the guest");
        assert!(host.seats[1].bot && host.seats[1].connected);
        assert_eq!(host.seats[1].name, "Guest");
        // Its pick for the step the table waited on, and its pick from the next pack.
        assert_eq!(draft.pool(1).len(), 2);
        assert!(
            draft.replace_with_bot(1).is_err(),
            "a bot already sits there"
        );
        assert!(draft.pick(1, first(&host)).is_err());

        // From here the host drafts alone, to the end.
        let mut picks = 1;
        while draft.status() == DraftStatus::Drafting {
            draft.pick(0, first(&draft.view(0))).unwrap();
            picks += 1;
        }
        assert_eq!(picks, 42);
        assert_eq!(draft.pool(1).len(), 42);
    });
}

#[test]
fn a_snapshot_resumes_where_it_left_off() {
    engine(|| {
        let mut draft = start(quick(Difficulty::Medium));
        for _ in 0..16 {
            draft.pick(0, first(&draft.view(0))).unwrap();
        }
        let snapshot = draft.snapshot();
        let ids = Draft::card_ids(&snapshot).unwrap();
        let all: Vec<String> = cards().into_iter().map(|c| c.card.card_id).collect();
        assert!(ids.iter().all(|id| all.contains(id)));
        let facts: Vec<CardFacts> = cards()
            .into_iter()
            .map(|c| c.card)
            .filter(|c| ids.contains(&c.card_id))
            .collect();

        let mut resumed = Draft::restore(&snapshot, facts).expect("the draft resumes");
        assert_eq!(resumed.view(0), draft.view(0));
        assert_eq!(resumed.view(0).pack_number, 1);
        assert_eq!(resumed.saved(5).updated_at, 5);
        assert_eq!(resumed.saved(5).pick_number, 2);
        // The bots roll the same dice after a resume.
        draft_out(&mut draft);
        draft_out(&mut resumed);
        assert_eq!(resumed.snapshot(), draft.snapshot());

        assert!(Draft::restore("{}", Vec::new()).is_err());
        assert!(Draft::card_ids("not json").is_err());
    });
}

#[test]
fn the_same_seed_drafts_the_same() {
    engine(|| {
        let mut one = start(quick(Difficulty::VeryEasy));
        let mut two = start(quick(Difficulty::VeryEasy));
        draft_out(&mut one);
        draft_out(&mut two);
        assert_eq!(one.snapshot(), two.snapshot());
    });
}

#[test]
fn a_booster_card_with_no_facts_is_refused() {
    engine(|| {
        let mut facts = cards();
        let gone = facts.remove(0).card.card_id;
        let setup = quick(Difficulty::VeryEasy);
        assert!(setup.card_ids().contains(&gone));
        let refusal = Draft::new(setup, facts).err().expect("refused");
        assert!(refusal.contains(&gone), "{refusal}");
    });
}

#[test]
fn a_plain_deck_row_is_facts_enough() {
    engine(|| {
        let facts: Vec<CardFacts> = cards().into_iter().map(|c| c.card).collect();
        let draft = Draft::new(quick(Difficulty::Easy), facts).unwrap();
        assert!(draft.db.is_none(), "an Easy bot reads no faces");
        let card = &draft.view(0).pack[0];
        assert_eq!(card.set_code, "tst", "the round's set");
        assert_eq!(card.rarity, "");
    });
}

#[test]
fn the_wire_is_camel_case() {
    engine(|| {
        let draft = start(quick(Difficulty::VeryEasy));
        let json = serde_json::to_value(draft.view(0)).unwrap();
        assert_eq!(json["mode"], "quick");
        assert_eq!(json["status"], "drafting");
        assert!(json["pack"][0]["instanceId"].is_string());
        assert!(json["seats"][0]["poolCount"].is_number());
        let setup: DraftSetup = serde_json::from_value(serde_json::json!({
            "mode": "pod", "difficulty": "veryHard", "seed": 1, "label": "",
            "seats": [{ "name": "A", "bot": false, "peer": null }],
            "packs": [], "packSets": [], "minDeckSize": 40,
        }))
        .unwrap();
        assert_eq!(setup.mode, DraftMode::Pod);
    });
}

/// The host keeps a draft across calls and hands it to the engine's thread.
#[test]
fn a_draft_crosses_threads() {
    fn send<T: Send + 'static>() {}
    send::<Draft>();
}

/// You and three bots, three rounds of 20-card boosters, two cards a pick.
fn commander(difficulty: Difficulty) -> DraftSetup {
    let mut seats = vec![person("You")];
    seats.extend(bots(3));
    let mut setup = setup(DraftMode::Commander, seats, 3, difficulty);
    setup.packs = boosters(4, 3, 20, 11);
    setup.min_deck_size = 60;
    setup
}

#[test]
fn a_commander_draft_picks_two_at_a_time_to_deckbuilding() {
    engine(|| {
        let mut draft = start(commander(Difficulty::Medium));
        let view = draft.view(0);
        assert_eq!((view.picks_per_step, view.commanders), (2, 1));
        assert_eq!(view.pack_size, 20);
        assert!(view.stack.is_none());
        assert!(
            view.seats[1..].iter().all(|s| s.picked),
            "the bots picked two each"
        );
        assert!(draft.pool(1).len() == 2);

        let before = draft.snapshot();
        let refusal = draft.pick(0, first(&view)).unwrap_err();
        assert_eq!(refusal, "Pick 2 cards from the pack.");
        assert_eq!(draft.snapshot(), before, "a one-card pick changes nothing");

        let mut steps = 0;
        while draft.status() == DraftStatus::Drafting {
            let view = draft.view(0);
            assert!(!view.waiting);
            let ids: Vec<String> = view.pack[..2]
                .iter()
                .map(|c| c.instance_id.clone())
                .collect();
            draft.pick(0, ids).expect("two cards are a pick");
            steps += 1;
            assert!(steps <= 30);
        }
        // Ten steps a 20-card booster, three boosters: every seat drafts all sixty it saw.
        assert_eq!(steps, 30);
        for seat in 0..4 {
            assert_eq!(draft.pool(seat).len(), 60, "seat {seat}'s pool");
        }
        assert_eq!(draft.view(0).commanders, 1);

        // "Pick for me" picks two.
        let mut auto = start(commander(Difficulty::Easy));
        auto.auto_pick(0).unwrap();
        assert_eq!(auto.view(0).pool.len(), 2);

        // phase seats a Commander draft three at the least.
        let mut small = commander(Difficulty::VeryEasy);
        small.seats.truncate(2);
        small.packs.truncate(2);
        assert!(Draft::new(small, cards()).is_err());
    });
}

/// Every instance id `setup`'s boosters deal, sorted.
fn dealt(setup: &DraftSetup) -> Vec<String> {
    let mut ids: Vec<String> = setup
        .packs
        .iter()
        .enumerate()
        .flat_map(|(seat, rounds)| {
            rounds.iter().enumerate().flat_map(move |(round, booster)| {
                booster
                    .iter()
                    .enumerate()
                    .map(move |(index, id)| format!("{id}#{seat}.{round}.{index}"))
            })
        })
        .collect();
    ids.sort();
    ids
}

/// Every instance id in a pool, sorted.
fn pooled(draft: &Draft) -> Vec<String> {
    let mut ids: Vec<String> = draft
        .session
        .pools
        .iter()
        .flatten()
        .map(|c| c.instance_id.clone())
        .collect();
    ids.sort();
    ids
}

/// You against one bot, three boosters each.
fn winston(difficulty: Difficulty) -> DraftSetup {
    let mut seats = vec![person("You")];
    seats.extend(bots(1));
    setup(DraftMode::Winston, seats, 3, difficulty)
}

/// The seat's view tells it no card it may not see: no pack, and a pile's cards only on its own
/// turn, for the pile in play, the whole pile.
fn sees_only_its_pile(view: &DraftView) {
    assert!(view.pack.is_empty());
    let stack = view.stack.as_ref().expect("a Winston view has its table");
    assert_eq!(stack.piles.len(), 3);
    assert_eq!(
        view.waiting,
        view.status == DraftStatus::Drafting && !stack.your_turn
    );
    for (i, pile) in stack.piles.iter().enumerate() {
        assert_eq!(pile.active, stack.active_pile == Some(i as u8));
        if stack.your_turn && pile.active {
            assert_eq!(pile.cards.len() as u32, pile.count);
        } else {
            assert!(pile.cards.is_empty(), "pile {i} shown off its turn");
        }
    }
}

#[test]
fn a_winston_draft_against_a_bot_runs_to_the_end() {
    engine(|| {
        let setup = winston(Difficulty::Medium);
        let all = dealt(&setup);
        assert_eq!(all.len(), 84);
        let mut draft = start(setup);
        let view = draft.view(0);
        assert_eq!(view.mode, DraftMode::Winston);
        assert_eq!(
            (view.pack_number, view.pick_number, view.pack_size),
            (0, 0, 0)
        );
        assert_eq!((view.picks_per_step, view.commanders), (1, 0));
        let stack = view.stack.clone().unwrap();
        assert!(stack.your_turn, "the bot took its turns before the view");
        assert_eq!(stack.turn_seat, 0);
        assert!(!view.waiting && view.seats[1].picked && !view.seats[0].picked);
        sees_only_its_pile(&view);
        sees_only_its_pile(&draft.view(1));

        // No pick in a Winston draft, no other pile, no turn for a bot's seat.
        let before = draft.snapshot();
        assert!(draft.pick(0, vec!["x".into()]).is_err());
        assert_eq!(
            draft.winston(0, 1, true).unwrap_err(),
            "That is not the pile in play."
        );
        assert!(draft.winston(1, 0, true).is_err());
        assert_eq!(draft.snapshot(), before);

        let mut decisions = 0;
        let mut takes = 0;
        while draft.status() == DraftStatus::Drafting {
            let view = draft.view(0);
            sees_only_its_pile(&view);
            sees_only_its_pile(&draft.view(1));
            assert!(!view.waiting, "the bot never keeps the reader waiting");
            let stack = view.stack.unwrap();
            let pile = stack.active_pile.unwrap();
            // Decline while the rules allow it; a refused decline changes nothing.
            let before = draft.snapshot();
            if draft.winston(0, pile, false).is_err() {
                assert_eq!(draft.snapshot(), before);
                draft
                    .winston(0, pile, true)
                    .expect("a take is always there");
                takes += 1;
            }
            decisions += 1;
            assert!(decisions < 500, "the draft ends");
        }
        assert!(takes > 0);
        assert_eq!(pooled(&draft), all, "every card ends in a pool, once");
        let view = draft.view(0);
        assert_eq!(view.status, DraftStatus::Deckbuilding);
        let stack = view.stack.unwrap();
        assert_eq!(stack.active_pile, None);
        assert!(!stack.your_turn && stack.main_count == 0);
        assert!(stack
            .piles
            .iter()
            .all(|p| p.count == 0 && p.cards.is_empty()));
        assert!(!view.waiting);
        assert_eq!(
            view.pool.len() + draft.pool(1).len(),
            84,
            "the two pools are the whole stack"
        );
        assert!(draft.winston(0, 0, true).is_err());

        // A Winston draft opens three boosters a seat.
        let mut short = winston(Difficulty::VeryEasy);
        short.packs = boosters(2, 2, 14, 7);
        short.pack_sets.truncate(2);
        assert!(Draft::new(short, cards()).is_err());
    });
}

#[test]
fn a_pod_winston_between_two_people_takes_turns() {
    engine(|| {
        let mut seats = vec![person("Host"), person("Guest")];
        seats[1].peer = Some("p1".into());
        let mut setup = setup(DraftMode::Pod, seats, 3, Difficulty::VeryEasy);
        setup.pod_format = PodFormat::Winston;
        let all = dealt(&setup);
        let mut draft = start(setup);
        assert_eq!(draft.view(0).pod_format, PodFormat::Winston);

        let mut takes = 0;
        let mut decisions = 0;
        while draft.status() == DraftStatus::Drafting {
            let turn = draft.view(0).stack.unwrap().turn_seat;
            let other = 1 - turn;
            let (mine, theirs) = (draft.view(turn), draft.view(other));
            sees_only_its_pile(&mine);
            sees_only_its_pile(&theirs);
            assert!(!mine.waiting && theirs.waiting);
            assert!(theirs.seats[usize::from(other)].picked);
            // The seat off its turn is refused, and nothing moves.
            let before = draft.snapshot();
            assert!(draft.auto_pick(other).is_err());
            assert!(draft.winston(other, 0, true).is_err());
            assert_eq!(draft.snapshot(), before);

            let stack = mine.stack.unwrap();
            let pile = stack.active_pile.unwrap();
            if stack.piles[usize::from(pile)].count > 0 {
                draft
                    .winston(turn, pile, true)
                    .expect("a pile with cards is taken");
                takes += 1;
                if draft.status() == DraftStatus::Drafting {
                    let next = draft.view(0).stack.unwrap();
                    assert_eq!(next.turn_seat, other, "a take ends the turn");
                    assert_eq!(next.active_pile, Some(0));
                }
            } else {
                draft
                    .auto_pick(turn)
                    .expect("the first legal decision is taken");
            }
            decisions += 1;
            assert!(decisions < 500);
        }
        assert!(takes > 10);
        assert_eq!(pooled(&draft), all);
        // A pod is a pod; its format only says what it drafts.
        assert_eq!(draft.view(1).mode, DraftMode::Pod);
    });
}

#[test]
fn a_winston_snapshot_resumes_mid_turn() {
    engine(|| {
        let mut draft = start(winston(Difficulty::Medium));
        for _ in 0..12 {
            draft.auto_pick(0).unwrap();
        }
        let snapshot = draft.snapshot();
        let ids = Draft::card_ids(&snapshot).unwrap();
        let facts: Vec<CardFacts> = cards()
            .into_iter()
            .map(|c| c.card)
            .filter(|c| ids.contains(&c.card_id))
            .collect();
        assert_eq!(ids.len(), facts.len());
        let mut resumed = Draft::restore(&snapshot, facts).expect("the draft resumes");
        assert_eq!(resumed.view(0), draft.view(0));
        assert_eq!(resumed.view(1), draft.view(1));
        while draft.status() == DraftStatus::Drafting {
            draft.auto_pick(0).unwrap();
        }
        while resumed.status() == DraftStatus::Drafting {
            resumed.auto_pick(0).unwrap();
        }
        assert_eq!(
            resumed.snapshot(),
            draft.snapshot(),
            "the bot decides as it would have"
        );
    });
}

#[test]
fn a_snapshot_from_before_pod_formats_still_resumes() {
    engine(|| {
        let draft = start(quick(Difficulty::VeryEasy));
        let mut old: serde_json::Value = serde_json::from_str(&draft.snapshot()).unwrap();
        old["setup"]
            .as_object_mut()
            .unwrap()
            .remove("podFormat")
            .expect("the snapshot names the pod's format");
        let old = old.to_string();
        let facts: Vec<CardFacts> = cards().into_iter().map(|c| c.card).collect();
        let resumed = Draft::restore(&old, facts).expect("a version-1 snapshot resumes");
        assert_eq!(resumed.view(0), draft.view(0));
        assert_eq!(resumed.view(0).pod_format, PodFormat::Booster);
    });
}
