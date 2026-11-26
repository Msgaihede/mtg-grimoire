//! Cards outside the game (issue #1744): the deck's sideboard, which a wish finds, and its
//! companion, revealed at the start (CR 702.139a) and put into the hand for {3} (CR 702.139c).
//! Against the goldfish, outside a Commander game, where phase takes the companion from the
//! sideboard.

use crate::cards::{CardFacts, OutsidePile};
use crate::on_engine_stack;
use crate::view::{GameCard, Place};

use super::session::{Playtest, OUTSIDE_IDS};
use super::view::{
    Difficulty, PlaytestAction as A, PlaytestHappened as H, PlaytestPickPurpose, PlaytestPlayer,
    PlaytestStage as Stage, PlaytestStep,
};

const LURRUS: &str = "Lurrus of the Dream-Den";

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

/// Forests and Living Wish in the library (every permanent of mana value 2 or less, so Lurrus's
/// condition holds), Grizzly Bears in the sideboard, Lurrus as the companion.
fn deck() -> Vec<CardFacts> {
    let mut lurrus = card(
        LURRUS,
        Some("{1}{W/B}{W/B}"),
        "Legendary Creature — Cat Nightmare",
        "Lifelink\nDuring each of your turns, you may cast one permanent spell with mana value 2 or less from your graveyard.\nCompanion — Each permanent card in your starting deck has mana value 2 or less.",
        Some(("3", "2")),
        1,
    );
    lurrus.keywords = vec!["Lifelink".into(), "Companion".into()];
    lurrus.colors = vec!["W".into(), "B".into()];
    lurrus.color_identity = vec!["W".into(), "B".into()];
    lurrus.outside = Some(OutsidePile::Companion);
    let mut bears = card(
        "Grizzly Bears",
        Some("{1}{G}"),
        "Creature — Bear",
        "",
        Some(("2", "2")),
        2,
    );
    bears.outside = Some(OutsidePile::Sideboard);
    vec![
        card(
            "Forest",
            None,
            "Basic Land — Forest",
            "({T}: Add {G}.)",
            None,
            40,
        ),
        card(
            "Living Wish",
            Some("{1}{G}"),
            "Sorcery",
            "You may reveal a creature or land card you own from outside the game and put it into your hand. Exile Living Wish.",
            None,
            20,
        ),
        bears,
        lurrus,
    ]
}

fn engine<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> T {
    on_engine_stack(work).expect("the engine ran")
}

fn find<'a>(cards: &'a [GameCard], name: &str) -> Option<&'a GameCard> {
    cards.iter().find(|c| c.name == name)
}

/// A game against the goldfish with Lurrus revealed, kept at seven, at the first main phase;
/// and everything that happened on the way.
fn revealed() -> (Playtest, Vec<H>) {
    let (mut game, mut step) =
        Playtest::new(&deck(), &[], &[], 7, Difficulty::default()).expect("a game starts");
    let mut happened = step.happened.clone();
    for _ in 0..4 {
        if step.view.stage == Stage::Mulligan {
            break;
        }
        let prompt = step
            .view
            .prompt
            .clone()
            .expect("a question before the hand");
        assert_eq!(prompt.kind, "CompanionReveal", "{prompt:?}");
        let reveal = prompt
            .options
            .iter()
            .find(|o| o.label.as_deref() == Some(LURRUS))
            .unwrap_or_else(|| panic!("the reveal names its companion: {:?}", prompt.options));
        step = game
            .act(A::Choose {
                index: reveal.index,
            })
            .expect("reveal");
        happened.extend(step.happened.clone());
    }
    let step = game.act(A::Keep { bottom: vec![] }).expect("keep seven");
    happened.extend(step.happened);
    (game, happened)
}

/// Draw until the hand holds `name`.
fn in_hand(game: &mut Playtest, name: &str) -> u64 {
    for _ in 0..80 {
        if let Some(c) = find(&game.view().you.hand, name) {
            return c.id;
        }
        game.act(A::Draw { count: 1 }).expect("draw");
    }
    panic!("never drew {name}");
}

/// `n` Forests put onto the battlefield by hand, untapped.
fn lands(game: &mut Playtest, n: usize) {
    for _ in 0..n {
        let id = in_hand(game, "Forest");
        game.act(A::Move {
            id,
            to: Place::Battlefield,
        })
        .expect("put a Forest down");
    }
}

#[test]
fn the_companion_is_revealed_and_put_into_the_hand_for_three() {
    let (before, after, refused, happened) = engine(|| {
        let (mut game, happened) = revealed();
        let refused = game.act(A::CompanionToHand).unwrap_err();
        let before = game.view();
        lands(&mut game, 3);
        let ready = game.view();
        let step = game.act(A::CompanionToHand).expect("the companion to hand");
        (before, (ready, step), refused, happened)
    });
    assert!(
        happened.contains(&H::CompanionRevealed {
            seat: PlaytestPlayer::You,
            name: LURRUS.into(),
        }),
        "{happened:?}"
    );
    let shown = before.you.companion.as_ref().expect("revealed, so public");
    assert_eq!(shown.name, LURRUS);
    assert_eq!(
        shown.card_id.as_deref(),
        Some("print-lurrus-of-the-dream-den")
    );
    assert!(!shown.to_hand, "no mana for it yet");
    assert!(refused.contains("{3}"), "{refused}");
    assert!(
        before.opponents[0].companion.is_none(),
        "the goldfish has none"
    );

    let (ready, step) = after;
    assert!(ready.you.companion.as_ref().unwrap().to_hand);
    assert!(
        step.happened.contains(&H::CompanionToHand {
            seat: PlaytestPlayer::You,
            name: LURRUS.into(),
        }),
        "{:?}",
        step.happened
    );
    let lurrus = find(&step.view.you.hand, LURRUS).expect("in the hand");
    assert_eq!(
        lurrus.card_id.as_deref(),
        Some("print-lurrus-of-the-dream-den")
    );
    assert!(step.view.you.companion.is_none(), "in the game now");
    assert!(
        step.view.you.battlefield.iter().all(|c| c.tapped),
        "the three Forests paid for it"
    );
}

#[test]
fn a_wish_picks_a_sideboard_card_or_the_companion_from_outside_the_game() {
    let (step, picked) = engine(|| {
        let (mut game, _) = revealed();
        lands(&mut game, 2);
        let wish = in_hand(&mut game, "Living Wish");
        let step: PlaytestStep = game.act(A::Play { id: wish }).expect("cast the wish");
        let bears = step
            .view
            .prompt
            .as_ref()
            .and_then(|p| p.pick.as_ref())
            .and_then(|p| p.cards.iter().find(|c| c.name == "Grizzly Bears"))
            .map(|c| c.id);
        let picked = bears.map(|id| game.act(A::PickCards { ids: vec![id] }).expect("pick"));
        (step, picked)
    });
    let prompt = step.view.prompt.as_ref().expect("the wish asks");
    let pick = prompt.pick.as_ref().unwrap_or_else(|| panic!("{prompt:?}"));
    assert_eq!(pick.purpose, PlaytestPickPurpose::Outside);
    assert_eq!((pick.min, pick.max), (0, 1), "you may");
    let names: Vec<&str> = pick.cards.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(
        names,
        vec!["Grizzly Bears", "Grizzly Bears", LURRUS],
        "each copy of the sideboard's, and the revealed companion"
    );
    assert!(pick.cards.iter().all(|c| c.id >= OUTSIDE_IDS));
    assert_eq!(pick.eligible.len(), 3);
    assert_eq!(pick.zone, None);
    assert_eq!(
        pick.cards[0].card_id.as_deref(),
        Some("print-grizzly-bears")
    );

    let picked = picked.unwrap();
    assert!(find(&picked.view.you.hand, "Grizzly Bears").is_some());
    assert!(
        picked.view.you.companion.is_some(),
        "the companion is still outside the game"
    );
}
