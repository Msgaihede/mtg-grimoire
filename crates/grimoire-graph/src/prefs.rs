//! The one preference a widget's numbers depend on — which marketplace prices are quoted at, and
//! in what currency.
//!
//! The rest of the page's prefs is window chrome (zoom, pane widths, folds), which no widget
//! draws. The core stores the marketplace's id and nothing else ([`grimoire_core::marketplace`]);
//! its label and currency are `MARKETPLACES` in `packages/ui/lib/marketplace.ts`, which
//! [`MarketplaceInfo`] transcribes — five rows, one fact written in two places.

use async_graphql::{Context, Object, Result};

use crate::{invalidatedBy, roots, Defaults, Marketplace};

/// A marketplace prices are quoted at, and how its money is written.
pub struct MarketplaceInfo(pub Marketplace);

impl MarketplaceInfo {
    /// The marketplace an id names; `None` for one this build does not know.
    fn of(id: &str) -> Option<Self> {
        let m = match id {
            "tcgplayer" => Marketplace::Tcgplayer,
            "cardmarket" => Marketplace::Cardmarket,
            "cardkingdom" => Marketplace::Cardkingdom,
            "manapool" => Marketplace::Manapool,
            "cardtrader" => Marketplace::Cardtrader,
            _ => return None,
        };
        Some(MarketplaceInfo(m))
    }
}

#[Object(rename_fields = "camelCase")]
impl MarketplaceInfo {
    async fn id(&self) -> Marketplace {
        self.0
    }
    /// The marketplace's name as the app writes it, e.g. `TCGplayer`, `Card Kingdom`.
    async fn label(&self) -> &'static str {
        match self.0 {
            Marketplace::Tcgplayer => "TCGplayer",
            Marketplace::Cardmarket => "Cardmarket",
            Marketplace::Cardkingdom => "Card Kingdom",
            Marketplace::Manapool => "Mana Pool",
            Marketplace::Cardtrader => "Card trader",
        }
    }
    /// `usd` or `eur`.
    async fn currency(&self) -> &'static str {
        match self.0 {
            Marketplace::Cardmarket | Marketplace::Cardtrader => "eur",
            Marketplace::Tcgplayer | Marketplace::Cardkingdom | Marketplace::Manapool => "usd",
        }
    }
}

/// This domain's batch loaders, for one execution — none.
pub(crate) fn data(
    request: async_graphql::Request,
    _state: &std::sync::Arc<grimoire_core::state::State>,
) -> async_graphql::Request {
    request
}

#[derive(Default)]
pub struct PrefsQuery;

#[Object(rename_fields = "camelCase")]
impl PrefsQuery {
    /// The marketplace every priced field answers at when it is not given one — the reader's
    /// choice, or this host's fallback when it cannot reach that one.
    // `["marketplace"]` is the root the picker writes and the feed refresh invalidates.
    #[graphql(directive = invalidatedBy::apply(roots(&["marketplace"])))]
    async fn marketplace(&self, ctx: &Context<'_>) -> Result<Option<MarketplaceInfo>> {
        let id = &ctx.data_unchecked::<Defaults>().marketplace;
        MarketplaceInfo::of(id)
            .map(Some)
            .ok_or_else(|| async_graphql::Error::new(format!("`{id}` is not a marketplace.")))
    }
}

#[cfg(test)]
mod tests {
    use grimoire_core::state::fixtures::on_files;
    use serde_json::json;

    use crate::Graph;

    #[test]
    fn the_marketplace_is_the_executions_with_its_label_and_currency() {
        let state = on_files("graph-prefs", "http://127.0.0.1:1").0;
        let graph = Graph::new();
        let ask = |marketplace: Option<&str>| {
            let response = graph.run(
                &state,
                "{ marketplace { id label currency } }",
                None,
                None,
                marketplace.map(str::to_owned),
            );
            assert!(response.errors.is_empty(), "{:?}", response.errors);
            response.data.into_json().unwrap()["marketplace"].clone()
        };
        // Nobody has chosen: the core's default.
        assert_eq!(
            ask(None),
            json!({ "id": "tcgplayer", "label": "TCGplayer", "currency": "usd" })
        );
        grimoire_core::marketplace::store(&state.lock_db(), "cardmarket").unwrap();
        assert_eq!(
            ask(None),
            json!({ "id": "cardmarket", "label": "Cardmarket", "currency": "eur" })
        );
        // The host's fallback wins over the stored choice.
        assert_eq!(
            ask(Some("cardkingdom")),
            json!({ "id": "cardkingdom", "label": "Card Kingdom", "currency": "usd" })
        );
    }

    /// Every id the core knows has a row here — the two lists cannot drift apart unnoticed.
    #[test]
    fn every_marketplace_the_core_knows_has_a_label_and_currency() {
        for id in grimoire_core::marketplace::MARKETPLACE_IDS {
            let info = super::MarketplaceInfo::of(id).unwrap_or_else(|| panic!("{id}"));
            assert_eq!(info.0.id(), id);
        }
    }
}
