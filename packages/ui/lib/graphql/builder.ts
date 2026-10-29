/**
 * The one Pothos builder every domain file in `./schema/` registers its types and fields on.
 *
 * **A read-only graph over the `ipc` mirror, executed in the page.** There is no server: a
 * document is run by `./execute.ts` as a function call, and every resolver answers through the
 * typed `ipc` wrappers — so the graph reaches every host the wrappers reach (Tauri on the
 * desktop and Android, the WASM Worker on the web, the fake in every test and story) and adds
 * no command to any of them. Rust still supplies the facts; this file only names them.
 *
 * **Code-first, so the compiler is the parity fence.** A field is `t.exposeString("name")` on an
 * `objectRef<Shape>` whose shape is the `ipc` interface itself, and Pothos refuses a name the
 * shape does not have or a type it does not carry. `ipc.test.ts` holds the interface to the Rust
 * struct; this holds the graph to the interface. No third copy of a field list exists to drift.
 *
 * **No `Mutation` type, deliberately.** The graph exists for widgets a reader generates, and a
 * generated widget draws what is there — it does not move cards. `./execute.ts` refuses a
 * mutation or a subscription by name before execution as well, so adding a write is a decision
 * somebody makes in two places rather than something a domain file can do alone.
 */
import SchemaBuilder from "@pothos/core";
import { MARKETPLACE_IDS, type MarketplaceId } from "@/lib/marketplace";

/**
 * What one execution carries: the marketplace a priced field answers at when the document did
 * not name one, and a per-execution memo.
 *
 * {@link GraphQLContext.once} is the whole of the batching story for now. A command that answers
 * every row at once — `deck_values`, `deck_list` — is read once per document however many
 * fields reach it, and a nested resolver (a deck's value) picks its row out of that one answer
 * rather than asking per deck. A domain that needs more than that adds a batched read in Rust,
 * the way the widgets already do.
 */
export interface GraphQLContext {
  /** The marketplace a field with no `marketplace` argument answers at. */
  marketplace: MarketplaceId;
  /** Run `load` once per key for the life of this execution and share its promise. */
  once<T>(key: string, load: () => Promise<T>): Promise<T>;
}

export const builder = new SchemaBuilder<{
  Context: GraphQLContext;
  // Every field is non-null unless it says otherwise, which is what the `ipc` interfaces say:
  // a `T | null` there is `nullable: true` here, and everything else is always present.
  DefaultFieldNullability: false;
  Scalars: {
    /** Any JSON value — for the few shapes that are the reader's own document, opaque to Rust
     *  as well (a widget's `config`), and never for a shape this graph could spell out. */
    JSON: { Input: unknown; Output: unknown };
  };
}>({ defaultFieldNullability: false });

builder.queryType({
  description:
    "Everything MTG Grimoire knows about this reader's collection, wishlist, decks and home page, read-only.",
});

builder.scalarType("JSON", {
  description: "Any JSON value. Used only for documents the app itself stores opaquely.",
  serialize: (value) => value,
  parseValue: (value) => value,
});

/**
 * The marketplace a price is quoted at. Its values are `MARKETPLACE_IDS` verbatim, so a
 * marketplace added there is a value here with nothing else to edit.
 */
export const MarketplaceEnum = builder.enumType("Marketplace", {
  description: "A marketplace prices are quoted at. Defaults to the one the reader has chosen.",
  values: MARKETPLACE_IDS,
});

/**
 * The extension key a root field's cache roots ride under. Read by `./execute.ts`'s `rootsOf`.
 */
export const ROOTS = "grimoireRoots";

/**
 * The query roots a root field's answer is stale under — the first segment of the key the app's
 * own reader of the same command uses, so the writes that already invalidate that reader reach
 * this field too (`@/lib/query`'s `OWNED_WRITE_KEYS`, `crossWindow.ts`' `TABLE_KEYS`).
 *
 * **Required on every root field**, and `graphql.test.ts` fails on one without it: a field with
 * no roots is a widget that never refreshes after the write that changed it. Spread into a
 * field's options: `{ ...invalidatedBy("collection"), type: …, resolve: … }`.
 *
 * **A whole root, never a longer prefix.** `./useGraphQL.ts` keeps a marker query under each
 * root so an invalidation always has something to match, and a marker under a longer prefix —
 * `["collection", "list"]` — would sit where `useOptimisticEntries` walks every entry expecting
 * a page of rows. Under the bare root it sits beside `ActivityWidget`'s, which is the proven
 * place. The cost is a refetch on a sibling's write, which is a local read.
 */
export function invalidatedBy(...roots: string[]): { extensions: Record<string, string[]> } {
  return { extensions: { [ROOTS]: roots } };
}

/**
 * The marketplace a field answers at: the document's own, or the reader's.
 *
 * Every priced root field takes an optional `marketplace` argument and resolves it through this,
 * so a document that names none follows the reader's choice — and `./useGraphQL.ts` keys on that
 * choice, which is what re-asks every priced document when the picker moves.
 */
export function marketplaceOf(
  args: { marketplace?: MarketplaceId | null },
  ctx: GraphQLContext,
): MarketplaceId {
  return args.marketplace ?? ctx.marketplace;
}
