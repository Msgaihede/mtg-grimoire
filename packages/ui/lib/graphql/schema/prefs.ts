/**
 * The graph's half of `lib/ipc/prefs.ts`: the one preference a widget's numbers depend on — which
 * marketplace prices are quoted at, and in what currency.
 *
 * The rest of that file is window chrome (zoom, pane widths, folds), which no widget draws.
 */
import type { GraphQLContext } from "../builder";
import { builder, invalidatedBy, MarketplaceEnum } from "../builder";
import { MARKETPLACES, type Marketplace } from "@/lib/marketplace";

const MarketplaceInfoRef = builder.objectRef<Marketplace>("MarketplaceInfo").implement({
  description: "A marketplace prices are quoted at, and how its money is written.",
  fields: (t) => ({
    id: t.expose("id", { type: MarketplaceEnum }),
    label: t.exposeString("label"),
    currency: t.exposeString("currency", { description: "`usd` or `eur`." }),
  }),
});

builder.queryFields((t) => ({
  marketplace: t.field({
    // `["marketplace"]` is the root the picker writes and the feed refresh invalidates.
    ...invalidatedBy("marketplace"),
    description:
      "The marketplace every priced field answers at when it is not given one — the reader's choice, or this host's fallback when it cannot reach that one.",
    type: MarketplaceInfoRef,
    resolve: (_root, _args, ctx: GraphQLContext) => MARKETPLACES[ctx.marketplace],
  }),
}));
