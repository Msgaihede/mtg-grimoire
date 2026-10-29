# The read graph (`packages/ui/lib/graphql/`)

A read-only GraphQL schema over the reader's own data, executed in the page. It exists so a
widget the reader generates — from this app's components, by a model that is handed the schema —
can show anything a hand-written widget shows, through one typed, introspectable door instead of
hundreds of `ipc` wrappers. Added 2026-10-29 as the prerequisite for generated home
widgets; nothing in the app reads through it yet.

The schema itself is [`packages/ui/lib/graphql/schema.graphql`](../../packages/ui/lib/graphql/schema.graphql),
printed from the code and checked against it by `graphql.test.ts`, so it is always the graph as
built. This page is the why.

## Where it runs, and why not in Rust

**In the page, as a function call: `runQuery({ query, variables })`.** There is no server and no
command. Every resolver answers through the typed `ipc` wrappers, which already reach every host
— Tauri on the desktop and Android, the WASM Worker on the web, the fake in every test and story —
so the graph reaches all of them with nothing added to any. A GraphQL client that takes a custom
fetcher can sit on top of `runQuery` unchanged.

A schema in `grimoire-core` (async-graphql) was weighed and refused:

- **The boundary.** Rust supplies facts and TypeScript draws conclusions. A field such as a deck's
  legality is TypeScript's conclusion (`features/decks/validation/`); a Rust graph could not answer
  it without a second copy of that logic.
- **Four hosts, one graph.** A Rust schema would have to compile into the web host's WASM, and the
  fake core would need a GraphQL implementation of its own to keep stories and tests on the same
  graph.
- **No new fence.** The graph's object types are the `ipc` interfaces (below), which `ipc.test.ts`
  already holds to the Rust structs. One mirror stays the source of truth.

The cost is a round trip per root field rather than one per document. `GraphQLContext.once`
shares a list command between every field of one execution that reaches it (a deck's `value` is
picked out of one `deck_values`), and a field that still needs more is a batched read added in
Rust, the way the widgets already ask for theirs.

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

`useGraphQL(query, { variables })` is `useQuery` over `runQuery`, under its own `["graphql"]`
root. A document can read the collection and the decks at once, and a TanStack key sits under one
prefix, so no key could be reached by both roots' invalidations. Instead:

1. **Every root field names its roots** — `...invalidatedBy("collection")` — the first segment of
   the key the app's own reader of the same command uses. `graphql.test.ts` fails on a root field
   without one. `rootsOf(document)` unions them for a document.
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
