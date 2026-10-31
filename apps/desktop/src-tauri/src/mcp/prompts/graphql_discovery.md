# Exploring MTG Grimoire's data graph

MTG Grimoire answers the whole of the user's data — collection, wishlist, decks, the card database,
Scryfall tags, prices and the home page — as one read-only GraphQL schema. Use it to answer a
question no single tool covers, or to write a custom home widget's data query.

## The three tools

1. `graph_schema` — the whole schema as SDL, with a description on every type and field. It is
   large: read it once, then search it for the field you need rather than reading it again.
2. `graph_validate` — checks a query without running it, naming the line and column of each problem.
3. `graph_query` — runs it, and answers `data`, `errors` and `extensions.invalidatedBy`.

Work small: find the root field, validate, run with a small `limit`, then widen.

## What is where (root fields)

| Area | Root fields |
| --- | --- |
| Collection | `collectionEntries`, `collectionSummary`, `collectionBreakdown`, `collectionFolders`, `collectionFolderSummaries`, `collectionValueHistory`, `cardHoldings` |
| Wishlist | `wishlistEntries`, `wishlistSummary`, `wishlistBreakdown`, `wishlistFolders`, `wishlistValueHistory`, `wishlistOptimizePlan` |
| Decks | `decks`, `deck`, `deckFolders`, `deckCategories`, `deckValues`, `deckCompletion`, `deckHistory`, `deckNotes`, `deckTodoLists`, `deckLabels` |
| Cards | `searchCards`, `card`, `cardPrintings`, `sets`, `formats`, `setCompletion`, `upcomingSets`, `newPrintings` |
| Tags | `tagSearch`, `tagChildren`, `oracleTagsForCards`, `oracleTagsForPrintings`, `mutedTags` |
| Prices | `marketplace`, `printingPrices`, `priceHistory`, `priceMovers` |
| Home and activity | `activity`, `recentCards`, `stickyNotes`, `homeLayout`, `releaseNotes` |

## How the schema reads

- **Queries only.** There is no mutation; the graph cannot change anything.
- **Every root field is nullable**: one that is refused is `null` with an entry in `errors`, and the
  rest of the answer stands. Read `errors` as well as `data`.
- **Ids are `Int`** (decks, folders, entries); a card printing is a Scryfall id `String`.
- **Money is `Float`** in the user's marketplace currency unless a field takes `marketplace`;
  `null` is an unknown price, never zero. **Timestamps are Unix seconds** unless a description says
  milliseconds.
- **Card searches take `filters: CardFilterInput`** — structured, not the app's search syntax:
  `types`, `colors`, `manaValues`, `format`, `rarities`, `sets`, `text`, `oracleTags`, `artTags`
  and `predicates`. Tags are slugs; find them with `tagSearch`.
- **At most eight selection sets deep**, counted through fragments.
- **`@invalidatedBy(roots: [...])`** on each root field names the parts of the app whose changes
  make its answer stale — what keeps a home widget fresh. You do not need to act on it.
- **Variables work as usual**: declare them in the operation and pass `variables` to `graph_query`.

## Examples

How big the collection is, and what it is worth:

```graphql
query { collectionSummary { totalCards uniqueCards } }
```

Every active deck with its format and card count:

```graphql
query ActiveDecks($archived: Boolean) {
  decks(archived: $archived) { id name formatName cardCount }
}
```

(run with `variables: { "archived": false }`)

One deck whole, by its id from the query above — the deck, its piles and its cards:

```graphql
query { deck(id: 1) { deck { name } categories { name } cards { name quantity } } }
```

Find an Oracle Tag's slug, then search with it:

```graphql
query { tagSearch(text: "card draw", namespace: oracle, limit: 5) { slug label cardCount } }
```

## When something is refused

`graph_validate`'s problems name the field and where it is. An unknown field usually means a
different name or a nested type: search the SDL for the word. A missing argument names the
argument; its description says what it takes.
