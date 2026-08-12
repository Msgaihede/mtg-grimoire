# Card Kingdom and Mana Pool price feeds — live-verified

**Measured 2026-08-12** against the live endpoints, from Windows. Every number here came from
downloading the actual feed and counting, not from documentation.

## Both feeds are public, bulk, and keyed by `scryfall_id`

This is the fact that changes the design. The
[marketplace pricing spec](../specs/2026-08-12-card-marketplace-pricing-design.md) assumed
Card Kingdom would need fuzzy name + edition matching. **It does not** — every row carries a
real Scryfall UUID, so the join is exact.

| | Card Kingdom | Mana Pool |
| --- | --- | --- |
| Endpoint | `https://api.cardkingdom.com/api/v2/pricelist` | `https://manapool.com/api/v1/prices/singles` |
| Auth | none | none |
| Payload | 66 787 283 B (63.7 MiB) | 50 741 864 B (48.4 MiB) |
| Rows | 149 989 | 102 321 |
| Distinct `scryfall_id` | 97 239 | 99 502 |
| Rows with no `scryfall_id` | **832** | 0 |
| Currency | USD | USD |
| Shape | one row per SKU (printing × finish × variation) | one row per printing, finishes as columns |

Mana Pool publishes an OpenAPI document at `https://manapool.com/api/docs/v1/openapi.json`
(364 534 B). `/prices/singles` is declared with **no `security` block and no parameters**, and
an unauthenticated request returns 200 — the public part is real, not an accident. The rest of
the API (`/seller/*`, `/buyer/*`, `/inventory/*`, `/account`) is account-scoped and is not used
here. Server base is `https://manapool.com/api/v1`.

Card Kingdom's payload carries `meta.created_at` — `2026-08-11 21:07:02` when measured. That is
the staleness stamp to show, the same role Scryfall's bulk `updated_at` plays.

## Neither key is unique, and the duplicates are real

**Card Kingdom: 186 keys collide, covering 1 039 excess rows.** Almost all are double-faced
tokens — Card Kingdom stocks one physical card with two different backs and gives each its own
SKU, while Scryfall has one id:

```
0886657d-… |nonfoil   variation=''  price=0.35  qty=24  Radiation Token // Copy Token
0886657d-… |nonfoil   variation=''  price=0.35  qty=20  Radiation Token // Treasure Token (0018)
0886657d-… |nonfoil   variation=''  price=0.35  qty=21  Radiation Token // Zombie Mutant Token
```

A few are Card Kingdom's own data errors — `022bca13-…` is listed as both *Jade Monolith*
($2.49) and *Jade Statue* ($9.99).

**Mana Pool: 2 819 excess rows** over 99 502 distinct ids, the same token pattern.

**Consequence:** the ingest must pick deterministically, or the same card's price flickers
between syncs for no reason the user can see. Cheapest row wins, tie-broken by the feed's own
row id.

## Finishes

**Mana Pool has explicit finish columns**, including etched — which Cardmarket structurally
cannot supply, since `eur_etched` does not exist in Scryfall's data:

| Column family | Rows priced |
| --- | --- |
| `price_cents*` (nonfoil) | 88 702 |
| `price_cents_*_foil` | 63 251 |
| `price_cents_*_etched` | **1 198** |

**Card Kingdom encodes finish across two fields.** `is_foil` is a **string** `"true"`/`"false"`,
not a boolean (87 001 false / 62 988 true). Etched lives in the free-text `variation` field —
1 162 rows match `/etch/i`, of which 703 are exactly `Foil Etched`. So the finish rule is:

```
etched  if variation matches /etched/i
foil    else if is_foil == "true"
nonfoil otherwise
```

`variation` also carries `Promo Pack` (5 061), `Prerelease Foil` (3 828), `Extended Art`
(3 268), `Showcase` (1 408), `Borderless` (838), `Retro Frame` (414) and
`Not Tournament Legal` (980). **All but the last are separate printings in Scryfall with their
own ids, so the field is redundant there** — it must not be parsed into anything except the
etched test.

## The two feeds do not quote the same thing

This is the trap, and it is silent. Taking each feed's headline number would make Mana Pool
look systematically cheaper than Card Kingdom when it is not.

- **Card Kingdom `price_retail` is the Near Mint price.** It equals
  `condition_values.nm_price` on every row inspected; `ex`/`vg`/`g` step down from it
  (0.35 / 0.28 / 0.25 / 0.18 on the first row).
- **Mana Pool `price_cents` is the cheapest copy in any condition**, and `price_cents_nm` is
  the Near Mint one. Over a 4 000-row sample where both exist, **NM averages 1.20× the
  cheapest**.

Near Mint from both is what this app quotes: it is comparable across the two, and comparable
with TCGplayer and Cardmarket, which are themselves NM-ish market figures. The cost is
**3.1 %** of Mana Pool's nonfoil coverage — 85 979 NM-priced rows against 88 702 priced at all.

**Mana Pool prices are integer cents.** `price_cents: 218` is $2.18. Card Kingdom's are decimal
strings, like Scryfall's.

## The constraint that shapes the schema

`src-tauri/CLAUDE.md`: **`cards` is dropped and recreated on every sync**
(`schema::swap_staging`). Marketplace prices therefore **cannot** be columns on `cards` — they
would be destroyed by the next Scryfall sync and re-downloading 112 MiB to restore them is not
a recovery plan. They belong in their own table, keyed by `scryfall_id`, surviving the swap.

That table is also why a card can be priced by a marketplace and absent from `cards`, or the
reverse. Neither is an error: the feeds and the corpus are collected on different days.

## Sizes, for the sync budget

112 MiB across both, uncompressed, per full refresh. Neither endpoint advertises a rate limit
or an incremental mode, and Card Kingdom's `meta.created_at` shows a daily regeneration — so
once per day per selected marketplace is the ceiling worth asking for, and fetching a feed
nobody has selected is pure waste.
