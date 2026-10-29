# The read graph (`crates/grimoire-graph/` and `packages/ui/lib/graphql/`)

A read-only GraphQL schema over the reader's own data. It exists so a widget the reader generates
— declaratively, with json-render, from this app's components, by a model that is handed the
schema — can show anything a hand-written widget shows, through one typed, introspectable door
instead of hundreds of `ipc` wrappers. Added 2026-10-29 as the prerequisite for generated home
widgets; nothing in the app reads through it yet.

**There are two graphs while the port runs, and they are one schema.** The desktop answers from
Rust ([`crates/grimoire-graph`](../../crates/grimoire-graph/), its printout
[`schema.graphql`](../../crates/grimoire-graph/schema.graphql)); the page's graph
([`packages/ui/lib/graphql/`](../../packages/ui/lib/graphql/), printout
[`schema.graphql`](../../packages/ui/lib/graphql/schema.graphql)) is the complete one, answers every
story and suite through the fake, and is what the Rust side is ported from. `parity.test.ts` holds
every type, field, argument, default, enum value and cache root the Rust side has to the page's.

## Why the graph moved to Rust (2026-10-29)

It was first built in the page, over `ipc`, and the case for that was the boundary (Rust facts,
TypeScript conclusions), four hosts on one graph, and no new mirror. Two things changed it:

- **The MCP server is Rust, in the desktop.** It serves the schema to a model, checks the model's
  documents against it, and runs them for a preview — and a graph in the page can only be run
  while a window is open. In Rust all three need nothing but the database.
- **The owner's decision: desktop only** — no web or Android build needs the graph, so the WASM
  size and the four-host argument fell away.

What the move keeps from the first design: **the graph serves facts.** A conclusion TypeScript owns
(a deck's legality, a card's treatments) is not a field; a generated widget draws it through
json-render's `$computed`, whose functions the app registers in TypeScript. That is the boundary
in the shape a declarative widget has.

## The Rust graph (`crates/grimoire-graph`)

[async-graphql](https://crates.io/crates/async-graphql) 7, linked by the desktop alone (a workspace
member like `grimoire-play`, on `command_table::DESKTOP_ONLY`). **Three doors, all synchronous**,
shared by the page's command and the MCP server:

- **`Graph::sdl()`** — the printout, sorted, with `@invalidatedBy(roots: [...])` on every root
  field. Held to the code by `the_printed_schema_is_the_reviewed_one`
  (`GRAPH_SDL_WRITE=1 cargo test -p grimoire-graph` rewrites it).
- **`Graph::validate(query)`** — a document checked without running it: apollo-compiler reads the
  printout back and checks every rule of the specification, plus the graph's two (queries only;
  `MAX_DEPTH`, counted through fragments, as the page counts). Each `Problem` has a line and a
  column, which is what a model is told.
- **`Graph::run(state, query, variables, operation, marketplace)`** — executed on the calling
  thread. Every resolver takes the read connection's lock and drops it inside the call (a
  `MutexGuard` is not `Send`, so holding one across an `.await` does not compile). The desktop's
  `graphql_query` runs it on the blocking pool, as every read in this app runs.

**Batching is async-graphql's `DataLoader`, one per execution** (nothing cached between two
documents). A deck's `notes` collect every deck a level of the answer asked about and read them in
two statements (`deck_notes::list_notes_of_decks`, `json_each` over the ids); a deck's `value`
reads `deck_values_for` once per marketplace, whatever the number of decks.
`a_list_of_decks_costs_one_notes_read` pins it. A loader's future runs on a thread of its own,
driven to the end there: nothing in the crate has a runtime, and a thread is a fraction of the
read it carries.

**Ported in the spike:** `decks` (with `notes` and `value`), `deckValues`, `deckNotes`,
`collectionSummary`, `collectionFolders`. **Left out until decided:** the `query: String` argument
— a card search in Scryfall's syntax, which only TypeScript parses (`queryLanguage.ts`). The
port's choice is a structured filter input built from the core's own `CardFilters` (validated by
the schema, which suits a model) or a Rust port of the parser.

## The page's graph — where it runs

**In the page, as a function call: `runQuery({ query, variables })`.** Every resolver answers
through the typed `ipc` wrappers. `useGraphQL` no longer calls it: it calls `ipc.graphqlQuery`, which
the desktop answers from Rust and the fake answers by running this graph
(`packages/fake/graph.ts`) — so every story and suite runs the same documents the desktop does.

`GraphQLContext.once` shares a list command between every field of one execution that reaches it
(a deck's `value` is picked out of one `deck_values`).

## Code-first, and the compiler is the parity fence

The schema is built with [Pothos](https://pothos-graphql.dev/) on `builder.ts`. A type is
`builder.objectRef<IpcInterface>("Name")` and its fields are `t.exposeString("name")`,
`t.exposeInt(…)`, … — and Pothos refuses, at `tsc`, a field the interface does not have or a type
it does not carry. So a renamed or retyped `ipc` field is a compile error in the graph, exactly as
it is in every component that reads it.

- **One domain file per `lib/ipc/<domain>.ts`.** A root field lives in the file named after the
  `ipc` file its wrapper is in; an object type with the `ipc` file its interface is declared in.
  Each file exports its refs as `<Interface>Ref` for its siblings.
- **Int is 32-bit.** Ids, quantities and counts are `Int`; money, timestamps and anything that
  could pass 2³¹ are `Float`.
- **Every root field is nullable** (`schema.ts`' `withNullableRoots`), whatever its file declared:
  one refused read nulls its own field rather than the whole document a widget asked for. Below
  the root, nullability is the `ipc` shape's.
- **A backend refusal is the backend's sentence.** `ipc` rejects with a string; `schema.ts` wraps
  every resolver so the GraphQL error carries that string rather than graphql-js's "Unexpected
  error value".

## Read-only, and bounded

- **No `Mutation` type**, and `execute.ts` refuses a `mutation` or `subscription` operation by
  name as well. A generated widget draws; it does not move cards. A write added later is a decision
  made in two places.
- **A depth limit** (`MAX_DEPTH`, counted through fragments). Nothing is cyclic today; a nested
  relation added later could be, and a generated document should not turn one into a read per
  row per level.
- When generated widgets run, they should run in a sandboxed frame whose only channel is a
  document in and an `ExecutionResult` out — the graph is that channel, and nothing else a page
  can reach (`ipc`, the store) should cross it.

## Card searches take Scryfall's syntax

A field that filters cards takes `query: String`, in the syntax of every search box in the app
(`t:creature c:g otag:ramp`), turned into `CardFilters` by `filters.ts` through the one parser
(`features/search/queryLanguage.ts`). `CardFilters` is not mirrored as an input type: it would be
a second, structural spelling of the same question, and the syntax is what a person — or a model —
already knows. **A tag fails closed**, as the deck editor's box does: a tag no taxonomy knows is an
error naming it, never a filter quietly dropped.

## Freshness: roots, markers and one subscription

`useGraphQL(query, { variables })` is `useQuery` over `ipc.graphqlQuery`, under its own `["graphql"]`
root. A document can read the collection and the decks at once, and a TanStack key sits under one
prefix, so no key could be reached by both roots' invalidations. Instead:

1. **Every root field names its roots** — `...invalidatedBy("collection")` — the first segment of
   the key the app's own reader of the same command uses. `graphql.test.ts` fails on a root field
   without one. `rootsOf(document)` unions them for a document. The Rust graph prints the same
   roots as `@invalidatedBy(roots: [...])` on each root field, and `parity.test.ts` holds the
   two lists equal — so the hook can read either side and get the same answer.
2. **A marker query under each root** (`[root, "graphqlReadMarker"]`), because
   `invalidateQueries` dispatches nothing when it matches no cached query. A whole root, never a
   longer prefix: a marker under `["collection", "list"]` would sit where `useOptimisticEntries`
   walks every entry expecting a page of rows. Under the bare root it sits beside
   `ActivityWidget`'s, which is the same machinery and the precedent.
3. **One cache subscription** turns an `invalidate` under any of those roots into an invalidation
   of the document. Every write in the app already ends in one, and `crossWindow.ts` raises them
   for another window's writes.

**The marketplace is in the key.** A priced field with no `marketplace` argument answers at the
window's marketplace (`useMarketplace().marketplace`, after its host fallback), and switching it
writes `["marketplace"]` with `setQueryData` rather than invalidating — so it has to be in the key
for a document to be asked again.

## The widget census

`graphql.test.ts` reads the home feature's source (and the folder, marketplace and release-note
hooks its widgets draw from) for every `ipc.<name>`, and holds each to either a root field that
answers it or a named write. A widget that learns a new read fails there until the graph can
answer it too.

The same file then generates one document per root field, selecting every field it can reach
(to a fixed depth, never re-entering a type it is already inside, required arguments answered
from the starter world's own ids), and runs each against the fake backend. It requires no error
and no null root. This is what holds the graph's nullability and enums to the data rather than to
an interface's word for it — and its first run found one: a deck history row written by a newer
build carries a `kind` this build has never heard of (the starter seed holds one on purpose,
because `DeckHistoryDialog` draws such rows rather than dropping them). As an enum, that row was an
error that nulled the whole deck list; `kind` is a `String` for that reason. **A word the app itself
treats as open — a renderer that draws a value it does not know, as for history kinds, activity
kinds and widget kinds — is a `String` with its known values described; an enum is only for a set
Rust or a SQLite `CHECK` closes.**

## One graphql-js

graphql-js publishes a `development` build beside its production one and refuses a type made by
the other ("Cannot use GraphQLObjectType … from another module or realm"). Vite resolves the
`development` condition; Node, loading a dependency Vitest left external, does not — so
`vitest.config.ts` inlines `@pothos/core`, which builds the types this layer hands graphql.
