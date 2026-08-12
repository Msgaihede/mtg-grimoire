# Card Kingdom and Mana Pool price feeds — design

**Date:** 2026-08-12
**Status:** approved, ready to implement
**Builds on:** [the marketplace pricing spec](2026-08-12-card-marketplace-pricing-design.md) (PR #31)
**Facts:** [the live-verified feed research](../research/2026-08-12-card-kingdom-mana-pool-price-feeds.md)

## The ask

Card Kingdom and Mana Pool become real, selectable marketplaces with real prices. Card trader
stays listed and unselectable — its API needs a per-user JWT and has no bulk download.

Both feeds turned out to be public, unauthenticated, bulk, and **keyed by `scryfall_id`**, so
the fuzzy-matching objection that kept them out of PR #31 does not apply. See the research doc;
every number below was measured against the live endpoints on 2026-08-12.

## Decisions taken

- **Near Mint from both.** Card Kingdom `price_retail` (which *is* its NM price) and Mana Pool
  `price_cents_nm`. Comparable with each other and with TCGplayer/Cardmarket. Costs 3.1 % of
  Mana Pool's nonfoil coverage; the alternative quotes a Good-condition card against
  TCGplayer's NM figure, which is not a price comparison.
- **Fetch only what is selected.** A feed downloads the first time its marketplace is chosen,
  then refreshes at most daily while it stays chosen. Nobody downloads 63.7 MiB for a
  marketplace they never picked.
- **Ships as its own PR**, stacked on #31.

## This supersedes #31's twin-field decision

PR #31 has Rust return **both** currencies on every row (`unitPriceUsd` + `unitPriceEur`) so
that switching marketplace is a re-render rather than a refetch. That was right for two
marketplaces backed by two keys of one JSON blob. **It does not survive a third source.**

Card Kingdom and Mana Pool prices live in a *table*, not in `cards.prices`. Carrying every
marketplace on every row would mean four price fields per row today and a fifth the day
Card trader lands — each one a number that four out of five renders ignore.

**So the selected marketplace becomes a query parameter, and Rust returns one `unitPrice` per
row.** The frontend stops picking between twins and just renders the number it was given.
Switching marketplace refetches — against local SQLite, which is what every other filter in
this app already does.

This is a reversal, not a correction: #31's shape was correct for what #31 knew.

## Schema — a new migration step at the bottom of the ladder

`cards` is dropped and recreated on every sync (`schema::swap_staging`), so these prices
**cannot** be columns on it. They get their own tables, keyed by `scryfall_id`, surviving the
swap.

```sql
CREATE TABLE marketplace_prices (
  marketplace TEXT NOT NULL,   -- 'cardkingdom' | 'manapool'
  card_id     TEXT NOT NULL,   -- scryfall_id; deliberately NOT a foreign key
  finish      TEXT NOT NULL,   -- 'nonfoil' | 'foil' | 'etched'
  price       REAL NOT NULL,   -- Near Mint, in the marketplace's currency
  PRIMARY KEY (marketplace, card_id, finish)
) WITHOUT ROWID;

CREATE TABLE marketplace_feed_meta (
  marketplace   TEXT PRIMARY KEY,
  fetched_at    INTEGER NOT NULL,  -- unix seconds, when we pulled it
  feed_built_at TEXT,              -- the feed's own stamp (CK meta.created_at); NULL if none
  row_count     INTEGER NOT NULL
);
```

**No foreign key against `cards.id`**, matching the existing rule for user tables: a feed and
the card corpus are collected on different days, so a price for a card the corpus does not have
(and the reverse) is expected, not an error.

## Ingest

One module, `src-tauri/src/marketplace_feed.rs`, with a provider per feed behind a small trait
so a third is a new file rather than a new branch in five places.

**Streaming, not `serde_json::from_str`.** 63.7 MiB of JSON text expands to several times that
as live objects. Use `Deserializer::from_reader` over the HTTP body with a sequence visitor,
inserting in transactions of 1 000–5 000 rows — the same shape the Scryfall ingest already uses,
and for the same reason.

**Card Kingdom** (`api.cardkingdom.com/api/v2/pricelist`)

- Skip the **832 rows with no `scryfall_id`**. They are unjoinable, not an error.
- Finish: `etched` if `variation` matches `/etched/i`, else `foil` if `is_foil == "true"`, else
  `nonfoil`. **`is_foil` is the string `"true"`, not a boolean.**
- Price: `price_retail`, a decimal string. Parse as decimal, never float-first.
- `variation`'s other values (`Promo Pack`, `Extended Art`, `Showcase`, …) are separate
  printings in Scryfall with their own ids. **Do not parse them into anything.**
- Record `meta.created_at` as `feed_built_at`.

**Mana Pool** (`manapool.com/api/v1/prices/singles`)

- One row per printing; finishes are columns. Take `price_cents_nm`, `price_cents_nm_foil`,
  `price_cents_nm_etched` — the **NM** ones, not the bare `price_cents*`.
- **Integer cents.** `218` is `2.18`. Divide once, at the edge.
- A null column means that finish is unpriced — write no row, never a zero.
- The response is `{ data: [...] }`. No feed-built stamp; `feed_built_at` is NULL.

**Both: deduplicate deterministically.** Neither key is unique — Card Kingdom has 186 colliding
`(scryfall_id, finish)` keys over 1 039 excess rows, Mana Pool 2 819 excess rows, almost all
double-faced tokens sharing one Scryfall id. **Cheapest row wins, tie-broken by the feed's own
row id**, so the same card does not flicker between syncs for a reason no reader can see.

## Sync

`marketplace_feed_refresh(marketplace)` — a command, and a call at selection time.

- Selecting a feed-backed marketplace that has no rows fetches immediately, reporting progress
  through the existing `Activity` mechanism so the ribbon shows it like any other long job.
- A selected feed older than 24 h refreshes on the next app start or sync.
- **A failed fetch leaves the previous prices in place** and writes the reason to `error_log`.
  Stale prices with an honest as-of line beat an empty table.
- Writes go through `db::lock_for` and answer `collection::BUSY` under a running sync, like
  every other write.

## Query

`price_expr(marketplace)` builds the one SQL fragment every price site uses:

- `tcgplayer` / `cardmarket` → the existing `json_extract(c.prices, …)` per finish.
- `cardkingdom` / `manapool` → `LEFT JOIN marketplace_prices` on `(marketplace, card_id, finish)`.

Every list query (`search`, `collection`, `wishlist`, `deck`, `deck_meta`, `deck_theory`) takes
the marketplace and returns `unitPrice` / `price` / `totalPrice` — singular. The `Usd`/`Eur`
suffixes and the twin fields from #31 go away, along with the `currency` sort parameter, which
is subsumed: the marketplace decides both the source and the money.

## Frontend

- `MARKETPLACES.cardkingdom.priced` and `.manapool.priced` become `true`.
- `useMarketplace()` gains the feed state — never fetched / fetching / fresh / stale / failed —
  so Settings can show it and the price surfaces can say why a column is empty.
- Marketplace joins the query key of every price-bearing query. Switching refetches.
- Every `formatPrice(value, currency)` call keeps working unchanged; only the field it is
  handed changes name.
- **Unpriced stays an em dash.** A card the feed has never heard of is unpriced at that
  marketplace, and that is a fact about the marketplace, not a hole to fill from another one.

## Testing

- Ingest: a fixture per feed covering the finish rule, the string `"true"`, integer cents, the
  832 missing-id rows, a null NM column, and a token collision resolving to the cheapest row
  twice in a row.
- Query: each marketplace's `price_expr` against a seeded `marketplace_prices`, plus a card
  present in `cards` and absent from the feed reading as NULL.
- Sync: a failure leaves prior rows intact and writes to `error_log`.
- Frontend: the four priced marketplaces render, the feed states render, Card trader stays
  `aria-disabled`.
- Live CDP pass: select Card Kingdom, watch the fetch, confirm prices change and persist.
