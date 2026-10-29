# The read graph (`crates/grimoire-graph`)

A read-only GraphQL schema over the reader's own data, answered from SQLite by the desktop app.
It exists so a widget the reader generates — declaratively, with json-render, from this app's
components, by a model the MCP server hands the schema to — can show anything a hand-written
widget shows, through one typed, self-describing door instead of hundreds of commands. Added
2026-10-29 as the prerequisite for generated home widgets; no page reads through it yet.

The schema is [`crates/grimoire-graph/schema.graphql`](../../crates/grimoire-graph/schema.graphql),
printed from the code and held to it byte for byte by the crate's golden test
(`GRAPH_SDL_WRITE=1 cargo test -p grimoire-graph` rewrites it after an intended change). This
page is the why.

## Shape

- **Desktop only** (the owner's decision, 2026-10-29). A workspace member like `grimoire-play`,
  linked by `apps/desktop/src-tauri` alone; its command is on `command_table::DESKTOP_ONLY`. The
  web and Android hosts have no graph.
- **Rust, not the page.** It was first built in the page (TypeScript, Pothos, over `ipc`) and
  moved the same day: the MCP server is in the desktop and must serve, check and run documents
  with no window open, and a graph batched in SQL is the one worth having. The page holds **no
  schema and no GraphQL library**: a document is a string there, and every check is Rust's.
- **The graph serves facts.** A conclusion TypeScript owns (a deck's legality, a card's
  treatments, where a version-1 home layout's tiles land) is not a field; a generated widget
  draws it through json-render's `$computed`, whose functions the app registers in TypeScript.
  That is the boundary — Rust supplies facts, TypeScript draws conclusions — in the shape a
  declarative widget has.
- **Read-only.** No `Mutation` type; a `mutation` or `subscription` is refused in words of its
  own. Adding a write is the owner's decision.

## Three doors

Shared by the page's command and the MCP server, all synchronous (every caller is on a thread
that may block: the blocking pool, a test):

| Door                                                          | What                                                                                                                                                                                                                         | Callers                            |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `Graph::sdl()`                                                | The printout, sorted, with `@invalidatedBy(roots: [...])` on every root field                                                                                                                                                | MCP `graph_schema`                 |
| `Graph::validate(query)`                                      | apollo-compiler reads the printout back and checks every rule of the specification, plus the graph's two: queries only, and `MAX_DEPTH` (8) selection sets counted through fragments. Each `Problem` has a line and a column | MCP `graph_validate`               |
| `Graph::run(state, query, variables, operation, marketplace)` | Executes on the read connection. Never fails as a call — errors are entries in `errors` beside whatever `data` answered; `extensions.invalidatedBy` carries the document's cache roots                                       | `graphql_query`, MCP `graph_query` |

`apps/desktop/src-tauri/src/graph.rs` builds the one `Graph` the process has (`graph()`).

## Conventions

- **One module per domain**, named after the `ipc` file whose reads it answers (`decks`,
  `collection`, `wishlist`, `entry_tags`, `home`, `app`, `prefs`, `scanner`, `cards`, `tags`).
  Each owns its root fields (a `…Query` merged into `Query`), its types and its batch loaders,
  which it puts on a request through its own `data` function.
- **Types wrap the core's** (`pub struct Deck(pub Arc<DeckRow>)`, one getter per field), so a
  renamed core field is a compile error here. Ids, counts and quantities are `Int`; money and
  timestamps (Unix seconds unless a description says milliseconds) are `Float`.
- **Every root field is nullable** (`Result<Option<T>>`): a refusal nulls that field alone and
  the rest of a widget's document stands. Below the root, nullability is the core's shape.
- **A closed word a newer build can write is a `String`** with its known values described (a deck
  history row's `kind`, an activity line's `kind`): an enum would turn that row into an error.
  An enum is for a set Rust or a SQLite `CHECK` closes.
- **Card searches take `filters: CardFilterInput`** — the core's `CardFilters`, structured
  (`filters.rs`), serialised to the camelCase JSON the Search page sends and read by
  `CardFilters`' own `Deserialize`, so a filter means here exactly what it means there. The
  page's Scryfall syntax (`t:creature otag:ramp`) belongs to TypeScript's parser and is not
  repeated; the structured input is what the schema can validate, which suits a model.

## Batching

async-graphql's `DataLoader`, one per execution — nothing cached between two documents, so a
write between them is always seen. A nested edge asked of every row of a list is one read per
level: a deck's notes, to-do lists, labels, categories and history each go through a batched core
read (`list_notes_of_decks`, `lists_of_decks`, `labels_of_decks`, `categories_of_decks`,
`list_of_decks` — `IN (SELECT value FROM json_each(?1))` over the ids); a deck's value through one
`deck_values_for` per marketplace; a folder's summary through one summary per marketplace; a
card's Oracle Tags through one read per level. Whole-list reads (`deck_list`, the folder lists,
the format specs) are read once per execution and every edge picks its row from them. A loader's
future runs on a thread of its own, driven to the end there: nothing in the crate has a runtime,
and a thread is a fraction of the read it carries.

## Freshness on the page: roots, markers and one subscription

`useGraphQL(query, { variables })` (`packages/ui/lib/graphql/`) is `useQuery` over
`ipc.graphqlQuery`, under its own `["graphql"]` root. A document can read the collection and the
decks at once, and a TanStack key sits under one prefix, so no key could be reached by both
roots' invalidations. Instead:

1. **Every root field names its roots** — `@invalidatedBy(roots: ["collection"])`, the first
   segment of the key the app's own reader of the same command uses — and every answer carries
   the union its document read in `extensions.invalidatedBy` (`Graph::roots_of`). The crate's
   tests fail on a root field without one.
2. **A marker query under each root** (`[root, "graphqlReadMarker"]`), because
   `invalidateQueries` dispatches nothing when it matches no cached query. A whole root, never a
   longer prefix: a marker under `["collection", "list"]` would sit where `useOptimisticEntries`
   walks every entry expecting a page of rows. `ActivityWidget`'s feed is the same machinery and
   the precedent.
3. **One cache subscription** turns an `invalidate` under any of those roots into an invalidation
   of the document. Every write in the app already ends in one, and `crossWindow.ts` raises them
   for another window's writes.

**The marketplace is in the key.** A priced field with no `marketplace` argument answers at the
window's marketplace (`useMarketplace().marketplace`, after its host fallback), and switching it
writes `["marketplace"]` with `setQueryData` rather than invalidating — so it has to be in the key
for a document to be asked again.

The fake answers `graphql_query` with an error (`packages/fake/graph.ts`): a story or a suite
that draws a widget over the graph hands it its answer (`vi.spyOn(ipc, "graphqlQuery")`).

## The widget census

`packages/ui/features/home/graphCoverage.test.ts` reads the home feature's source (and the
folder, marketplace and release-note hooks its widgets draw from) for every `ipc.<name>`, and
holds each to either a root field of the printed schema or a named write. A widget that learns a
new read fails there until the graph can answer it too.

## Where the graph and the page differ

- **`homeLayout` answers the document as stored.** The page's `parseLayout` places a version-1
  document's tiles by each widget kind's footprint, which only TypeScript's registry knows; here a
  version-1 row answers with its tiles at `0`. Every document this build writes is version 2.
- **`releaseNotes`** are the `changelog/*.md` files embedded at build time (`build.rs`), with each
  release's day read off `CHANGELOG.md` — about 340 KB in the binary, and the same notes the
  page's Change notes widget bundles.
- **Entry tags in use** fold spellings as the page does; their order approximates the page's
  `Intl.Collator` (case and digit runs agree; accented letters sort after `z`).
- **Card treatments** ("Surge Foil") are not a field: naming them is TypeScript's table.
