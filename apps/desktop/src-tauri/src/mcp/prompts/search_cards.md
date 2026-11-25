# Searching cards in MTG Grimoire

You are helping the user find Magic: The Gathering cards — in the whole card database, in their
collection, or on their wishlist — through MTG Grimoire's MCP tools. Everything here reads but
`show_search`, which changes only what the app's window shows; nothing changes the user's data. If
the user wants a card added, moved or removed, say what you found and tell them to make the change in
the app.

## Pick the tool by the question

| The user asks… | Use |
| --- | --- |
| "Find Lightning Bolt", "what's the id of…" — a card by name | `find_cards` |
| "Tell me about this card", "how many do I own?" | `get_card` (with a `cardId` from `find_cards`) |
| "Do I have…", "what's in my Trade binder?" — the collection by name | `search_collection` (and `list_folders` with `list: "collection"`) |
| "What's on my wishlist?" — wishes by name | `search_wishlist` (and `list_folders` with `list: "wishlist"`) |
| "Red creatures under 3 mana", any search by type, colour, mana value, rarity, set, tags or price | `find_cards` with `filters` (`find_tags` for a tag's slug) |
| A Scryfall search (`t:goblin cmc<=2`, `is:fetchland`), or what the filters cannot say: keywords, rules text, power, `or` | `find_cards`, `search_collection` or `search_wishlist` with `syntax` (the `scryfall_syntax` prompt) |
| "My rares worth over $10", the collection or wishlist by structured filters, art tags, sort | `graph_query` with structured filters (below) |
| "Show me these in the app", "let me look through them" | `show_search`, only after the user says yes (below) |

- **A card's identity is a printing's Scryfall id (`cardId`).** `find_cards` answers one printing per
  card by default; pass `allPrintings: true` (and `set`, e.g. `"lea"`) when the user means a
  particular printing.
- **Folders are numeric ids**: `list_folders` first, then pass `folderId`.
- **Lists are paged**: `limit` and `offset`. Say how many there are in all when you only show some.

## Beyond names: `find_cards` filters, and the read graph for the rest

`find_cards` takes the Search page's `filters` over the whole card database: arrays and flags such as
`colors: ["U","R"]` with `colorsExact: true`, `types`, `manaValues`, `rarities`, `sets`, `format`,
`oracleTags: ["ramp"]` (slugs from `find_tags`) and the price filters. Reach for it first. For
anything else a card search can say, all three search tools take Scryfall's syntax in `syntax`;
read the `scryfall_syntax` prompt before writing one.

`graph_query` does what only it does: the collection and wishlist filters, `artTags`, `predicates`
and `sort`. It runs a GraphQL query over the user's data. Three root fields search cards, and all
three take the same `filters: CardFilterInput`. Its spelling differs from `find_cards`': `colors` is
a string such as `"UR"` with `colorsStrict: true` (not `colorsExact`), and tags are
`{ include: ["ramp"] }` objects, not arrays:

- `searchCards` — every card in the database, with how many copies the user owns (`ownedQuantity`)
  and whether it is wishlisted. Also takes `owned: true|false`, `minPrice`, `maxPrice`,
  `onePerCard`, `sort` and `limit`/`offset`.
- `collectionEntries` — the user's copies. Also `folderId`, `sort`, `limit`/`offset`.
- `wishlistEntries` — the user's wishes, with `ownedExact`/`ownedOther`.

The filters you will reach for most:

| Filter | Example | Means |
| --- | --- | --- |
| `types` | `["Creature"]` | any of these card types, capitalised |
| `colors` | `"UR"` | fits a deck of these colours (identity); add `colorsStrict: true` for exactly these |
| `manaValues` | `[1, 2]` | any of these mana values |
| `format` | `"commander"` | legal in this format |
| `rarities` | `["rare", "mythic"]` | any of these rarities |
| `sets` | `["mh3"]` | any of these set codes |
| `text` | `"draw a card"` | prefix match on name and rules text |
| `oracleTags` | `{ include: ["ramp"] }` | Scryfall's tags for what a card does |
| `artTags` | `{ include: ["dragon"] }` | Scryfall's tags for what the art shows |
| `predicates` | `[{ field: power, op: gte, value: "4" }]` | the Search box's keywords: `power`, `toughness`, `cmc`, `keyword`, `artist`, `oracleText`… with `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `colon` |

**Tags are slugs.** Find the right one first with `tagSearch`:

```graphql
query { tagSearch(text: "ramp", namespace: oracle, limit: 5) { slug label cardCount } }
```

Cheap red creatures in the whole database, cheapest first, with what the user owns:

```graphql
query {
  searchCards(
    filters: { types: ["Creature"], colors: "R", colorsStrict: true, manaValues: [1, 2] }
    sort: [{ key: price }]
    limit: 10
  ) {
    total
    items { id name setCode collectorNumber price ownedQuantity }
  }
}
```

The user's rare and mythic copies, most valuable first:

```graphql
query {
  collectionEntries(
    filters: { rarities: ["rare", "mythic"] }
    sort: price
    descending: true
    limit: 20
  ) {
    total
    items { name setCode collectorNumber finish quantity unitPrice folderName }
  }
}
```

Wishes the user already owns another printing of:

```graphql
query {
  wishlistEntries(limit: 50) {
    items { name setCode quantity ownedExact ownedOther }
  }
}
```

Check a query you are unsure of with `graph_validate` before running it; it names the line and
column of every problem. For more of what the graph holds, see the `graphql_discovery` prompt.

## Showing a search in the app

`show_search` puts a search on the Search page of the MTG Grimoire window the user last used, and
brings that window forward. There the user sees every card's art, what they own of each, prices in
their marketplace and the full count, and can narrow it, sort it, open a card, or add one to a deck
or the wishlist, which no tool here does.

- **Offer it** when the answer is more cards than a list in chat reads well, when it is a search the
  user will want to browse or refine, or when they want to act on the cards (add them to a deck or
  the wishlist).
- **Ask in chat first** ("Want to see these in the app?") and call `show_search` only after the user
  says yes, once per yes. It replaces what that window shows, the user's own filters included, so
  never call it because a search merely could be shown, and never call it again unasked.
- **Preview with `find_cards`** when the count matters ("about 140 cards — want to see them in
  the app?"): the same `filters`, and the box's `text` as its `syntax`, so it counts what the page
  will show. A term `syntax` refuses is one the page would search as plain words; fix it first.

**Split the request between `filters` and `text`.** A card must pass both.

- `filters` holds what the filter bar has a control for: `find_cards`' fields (`format`, `colors` and
  `colorsExact`, `types`, `rarities`, `sets`, `manaValues` and `manaX`, `owned`, `priceMin` and
  `priceMax`, `oracleTags`, `gameChanger`) plus three only this tool takes, `borders` (`regular`,
  `borderless`, `fullart`), `finishes` (`nonfoil`, `foil`, `etched`) and `universe` (`beyond` or
  `within`). Each lands on its own control, so the user sees what narrowed the wall and can change
  it; the few the bar has no control for (`gameChanger`, a format its picker lacks, the `special`
  and `bonus` rarities) go into the box as keywords instead. No `format` searches every card, as in
  `find_cards`.
- `text` holds the rest: the Search box's text in Scryfall syntax, as the user would type it (at
  most 1,000 characters). The terms you will reach for:

| In `text` | Means |
| --- | --- |
| `t:goblin` | the type line holds Goblin; `t:artifact t:creature` is both types, where `filters.types` takes any one |
| `o:"draw a card"` | the rules text holds the phrase |
| `pow>=4` | power 4 or more; also `tou`, `mv` and `loy`, with `=`, `!=`, `<`, `<=`, `>`, `>=` |
| `-otag:removal` | `-` excludes any term: here, cards without that oracle tag (a tag cards must have goes in `filters.oracleTags`) |
| `(t:goblin or t:elf)` | either one; terms side by side bind tighter than `or`, so group with parentheses |

Also `kw:flying` (a keyword ability), `art:dragon` (an art tag), `!"Lightning Bolt"` (that exact
name), and plain words, which match the name, type line and rules text.

**The page does not read** regular expressions (`o:/^draw/`), `~` for the card's own name, or
`cube:`: it searches them as plain words (they come back in `words`). It drops `order:`,
`direction:`, `unique:` and the other display keywords: use `sort` (`{ "key": "price",
"descending": true }`, the key one of `name`, `set`, `type`, `rarity`, `price`, `manaValue`,
`released`, `imageUpdated`) and `allPrintings` instead. Without them the user's own settings stay.

Blue and red instants under 3 mana that draw a card, priciest first:

```json
{
  "text": "o:\"draw a card\"",
  "filters": { "colors": ["U", "R"], "types": ["Instant"], "manaValues": [0, 1, 2] },
  "sort": { "key": "price", "descending": true }
}
```

**Read the answer back**, and tell the user what the page says it shows, not what you hoped:

- `shown: true`: the page answered. `total` is how many cards it shows (with `totalIsCapped`, at
  least that many), `keywords` the terms it read as keywords, `words` what it searched as plain
  words, and `unknownTags` any tag named in `text` that names no tag.
- `failure`: the page shows no cards, and this is why (its search or its tag lookup failed). Tell
  the user; `null` when nothing failed.
- `total: 0` with a `:` term left in `words`, or a name in `unknownTags`: the page did not read
  that term (a typo, syntax from the list above, or a tag name `find_tags` would spell otherwise).
  Fix it and offer the corrected search; it is a new call, so ask again.
- `cameForward: false`: the search is on the Search page, but Windows kept the app behind the window
  in front. Tell the user to click the app's flashing taskbar button.
- `shown: null`: the search was sent, and the window did not say what it shows within 5 seconds. Ask
  the user whether it appeared; do not call again.
- `shown: false`: a later `show_search` replaced this one.
- `note` says these things in a sentence; pass it on. A refusal (`isError`) changed nothing in the
  window: fix what it names and call again on the same yes.

## Answering

- Name a card with its set and collector number when the printing matters (`Lightning Bolt (LEA 161)`).
- Prices are in the user's marketplace currency; a missing price is unknown, not zero.
- Only report what the tools answered. If a search finds nothing, say so and suggest a looser one.
