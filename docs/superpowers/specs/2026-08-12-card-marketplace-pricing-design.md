# Card marketplace pricing — design

**Date:** 2026-08-12
**Status:** approved, ready to plan

## The ask

A reader picks a card marketplace in Settings. Every price the app shows — search, collection,
decks, wishlist, the card pane, sorts and totals — comes from that marketplace, in its currency.

Five marketplaces: TCGplayer ($), Cardmarket (€), Card Kingdom ($), Mana Pool ($),
Card trader (€). TCGplayer is the default, because it is what every price in the app is today.

## What the data actually supports

Scryfall's `prices` blob has exactly six keys — `usd`, `usd_foil`, `usd_etched`, `eur`,
`eur_foil`, `tix` — verified across 4 513 real card objects in
[the Scryfall research doc](../research/2026-08-04-scryfall-api.md). `usd*` is TCGplayer and
`eur*` is Cardmarket. **The other three marketplaces are not in Scryfall's data at all.**

| Marketplace | Feed | Verdict |
| --- | --- | --- |
| TCGplayer | Scryfall `usd`/`usd_foil`/`usd_etched` | Live today |
| Cardmarket | Scryfall `eur`/`eur_foil` | Live today |
| Card Kingdom | `api.cardkingdom.com/api/v2/pricelist` — free, unauthenticated, daily | Keyed by CK's own name + edition, **not** `scryfall_id`; needs a fuzzy matcher |
| Mana Pool | `manapool.com/api/v1` | Docs not publicly readable; auth unconfirmed |
| Card trader | `api.cardtrader.com/api/v2` | Needs a per-user JWT, and prices are per-`blueprint_id` queries with no bulk download |

Each of the last three is a new external dependency, a new sync job, a new price table and an
ID-matching layer — against a root `CLAUDE.md` that names Scryfall as the only external
dependency. **This spec builds the whole marketplace abstraction and ships the two that Scryfall
feeds.** The other three appear in the picker, disabled, saying why. Wiring one up later is a
new price source behind an interface that already exists, not a rewrite of every price surface.

## The model

`src/lib/marketplace.ts` is the one new module.

```ts
export type Currency = "usd" | "eur";
export type MarketplaceId =
  | "tcgplayer" | "cardmarket" | "cardkingdom" | "manapool" | "cardtrader";

export interface Marketplace {
  id: MarketplaceId;
  label: string;
  currency: Currency;
  /** Whether this app can quote a price here yet. */
  priced: boolean;
}
```

| id | Label | Currency | `priced` |
| --- | --- | --- | --- |
| `tcgplayer` | TCGplayer | `usd` | yes — the default |
| `cardmarket` | Cardmarket | `eur` | yes |
| `cardkingdom` | Card Kingdom | `usd` | no |
| `manapool` | Mana Pool | `usd` | no |
| `cardtrader` | Card trader | `eur` | no |

**A marketplace is a label; the currency is the axis everything downstream turns on.** No price
code branches on a marketplace id — it takes a `Currency`, which is exactly the distinction
`cards.prices` already draws. That is what keeps the eventual Card Kingdom feed to one seam.

## Persistence

The setting outlives the process, so it lives in SQLite — in `app_meta`, the key/value table
`schema.rs:837` already creates, read and written by `update.rs`'s existing `get_app_meta` /
`set_app_meta`. **No schema migration.**

Two commands, in a new `src-tauri/src/marketplace.rs`:

- `get_marketplace() -> String` — the stored id, or `tcgplayer` when the row is missing **or
  holds a value this build does not recognise**. A future build's id must not brick an older
  one, and an unparseable setting is a fact about storage, not a reason to fail a query.
- `set_marketplace(id: String) -> Result<(), String>` — validates against the known ids and
  rejects anything else, so the table cannot accumulate junk.

The frontend reads it through TanStack Query rather than the zustand store: `store.ts`'s own
doc comment scopes that store to UI state and hands server-ish state to Query, and this is
backed by the database. `useMarketplace()` exposes the resolved `Marketplace` and a setter that
invalidates the price-bearing queries.

## The Rust boundary

Rust supplies both currencies as facts; TS picks which one to draw. Three shapes exist today.

**Already computes both — no change.** `card_row.rs:51` (`price_usd`/`price_eur`),
`collection.rs:652` (`unit_price_usd`/`unit_price_eur`, plus `value_*` and `unpriced_*`),
`wishlist.rs`.

**USD-only, gains a EUR twin.** `deck.rs:1754` `unit_price_usd`, `deck_meta.rs:167`
`total_price_usd`, `deck_theory.rs:54` `unit_price_usd`, and `CardSummary.price_usd` /
`price_low` / `price_high` in search.

The twin is the euro expression the codebase already uses, and it carries the etched hole with
it: `CASE finish WHEN 'foil' THEN '$.eur_foil' ELSE '$.eur' END` — there is no `'$.eur_etched'`
branch, because there is no such key.

**Sorted in SQL — takes a parameter.** `sorting.rs:88` orders by `c.price_usd`;
`collection.rs:833` orders by `unit_price_usd * e.quantity`. Ordering happens inside SQLite, so
these cannot be decided in TS. Each takes an explicit `Currency` argument.

### Why twin fields rather than a currency parameter everywhere

`collection.rs` already returns both currencies side by side, so twins are the established
shape rather than a new one. They keep the queries currency-agnostic instead of threading a
parameter through every deck command. And because both numbers are already in the query cache,
**switching marketplace re-renders instantly with no refetch** — a parameterised query would
refetch every price surface on every switch.

The cost is that the wire carries a number the current render ignores. At the row counts
involved that is a `f64` per row, which is not worth a refetch.

## Formatting

`src/lib/prices.ts` today exports `usdPrice(v)` and `eurPrice(v)`. They collapse into:

- `formatPrice(value: number | null, currency: Currency): string` — still an em dash for
  `null`, still never `$0.00`.
- `priceRange(low, high, currency)` in `priceRange.ts` gains the same argument.
- `PRICES_AS_OF` becomes a function of the marketplace: "TCGplayer prices as of the last card
  data sync."

Both `Intl.NumberFormat` instances stay module-level constants — one per currency, picked by
lookup. Building one per call is the thing the module was written to stop.

## Settings UI

A new `src/features/settings/MarketplacePanel.tsx`, mounted in `SettingsPage` above the
"Not here yet" blurb. It lists all five with their currency beside the name.

- The two priced ones are selectable; the current one is marked.
- The three unpriced ones are **`aria-disabled`, never the `disabled` attribute** — `src/CLAUDE.md`
  is binding on this, and a `disabled` control leaves the tab order. Each says "No price feed yet".
- Selecting writes through `useMarketplace()`; the change is visible everywhere on the next
  render, with no sync and no refetch.

## What deliberately does not change

- **`collection_entries.purchase_price` never converts.** It is what the reader paid, in
  whatever they paid it in. Converting it would need an FX feed — a fourth external dependency —
  and would make a historical fact a moving number.
- **`tix` stays out.** MTGO event tickets are not a marketplace and are not fiat.
- **The etched-in-euros hole stays open.** On Cardmarket an etched card is unpriced, not valued
  at the nonfoil rate. `collection.rs:1858` and `wishlist.rs:1567` already assert this; the new
  code must not "fix" it.

## Testing

- Rust: `marketplace.rs` round-trip, the unknown-value fallback, `set_marketplace` rejection,
  and a EUR twin per new field — including an etched row proving it is `NULL` in euros.
- TS: `marketplace.ts` table integrity, `formatPrice`/`priceRange` in both currencies,
  `MarketplacePanel` selection and the `aria-disabled` three.
- Full `npm run verify`, then a live CDP pass over the real window — a green suite proves
  nothing about the shipped app, per the root `CLAUDE.md`.
