//! The closed words more than one domain of the graph speaks, spelt as the page's graph spelt
//! them (and as the core stores them). An enum only one domain uses lives in that domain's file.

use async_graphql::Enum;
use serde::Serialize;

/// A printing's finish.
#[derive(Enum, Serialize, Copy, Clone, Debug, PartialEq, Eq)]
#[graphql(rename_items = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum Finish {
    Nonfoil,
    Foil,
    Etched,
}

impl Finish {
    /// The word the core stores.
    pub fn id(self) -> &'static str {
        match self {
            Finish::Nonfoil => "nonfoil",
            Finish::Foil => "foil",
            Finish::Etched => "etched",
        }
    }

    /// The core's word read back; `None` for one this build does not know.
    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            "nonfoil" => Some(Finish::Nonfoil),
            "foil" => Some(Finish::Foil),
            "etched" => Some(Finish::Etched),
            _ => None,
        }
    }
}

/// A copy's condition. `NONE` is a copy nobody graded.
#[derive(Enum, Copy, Clone, Debug, PartialEq, Eq)]
#[graphql(rename_items = "UPPERCASE")]
pub enum Condition {
    None,
    Nm,
    Lp,
    Mp,
    Hp,
    Dmg,
}

impl Condition {
    /// The core's word read back; `None` for one this build does not know.
    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            "NONE" => Some(Condition::None),
            "NM" => Some(Condition::Nm),
            "LP" => Some(Condition::Lp),
            "MP" => Some(Condition::Mp),
            "HP" => Some(Condition::Hp),
            "DMG" => Some(Condition::Dmg),
            _ => None,
        }
    }
}

/// Which list of a deck: `live` is the deck as built, `theory` the version being planned.
#[derive(Enum, Copy, Clone, Debug, PartialEq, Eq, Default)]
#[graphql(rename_items = "lowercase")]
pub enum DeckVariant {
    #[default]
    Live,
    Theory,
}

impl DeckVariant {
    /// The word the core takes.
    pub fn id(self) -> &'static str {
        match self {
            DeckVariant::Live => "live",
            DeckVariant::Theory => "theory",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            "live" => Some(DeckVariant::Live),
            "theory" => Some(DeckVariant::Theory),
            _ => None,
        }
    }
}

/// One of Scryfall's two Tagger datasets: `oracle` tags say what a card does, `art` tags what its
/// illustration shows.
#[derive(Enum, Copy, Clone, Debug, PartialEq, Eq)]
#[graphql(rename_items = "lowercase")]
pub enum TagNamespace {
    Art,
    Oracle,
}

impl TagNamespace {
    pub fn id(self) -> &'static str {
        match self {
            TagNamespace::Art => "art",
            TagNamespace::Oracle => "oracle",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            "art" => Some(TagNamespace::Art),
            "oracle" => Some(TagNamespace::Oracle),
            _ => None,
        }
    }
}
