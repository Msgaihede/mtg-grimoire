/**
 * Run a GraphQL document against `./schema.ts`, in the page — the graph's whole transport.
 *
 * **A function call rather than a server.** Every resolver already answers through `ipc`, which
 * already reaches every host; putting an HTTP hop in front of that would add a listener to the
 * desktop and nothing to anybody. A caller hands a document in and gets a standard
 * `ExecutionResult` back, so any GraphQL client that can take a custom fetcher can sit on top.
 *
 * **Two rules beyond the specification's, both checked before a resolver runs:**
 *
 * - **Queries only.** The schema has no `Mutation` type, and this refuses a `mutation` or
 *   `subscription` operation by name as well — the graph is for widgets that draw, and a
 *   document a model wrote is not where a write should be discovered.
 * - **A depth limit** ({@link MAX_DEPTH}). Nothing in the graph is cyclic today, but a nested
 *   relation added later could be, and a generated document should not be able to turn one into
 *   a read per row per level.
 */
import {
  GraphQLError,
  Kind,
  OperationTypeNode,
  execute,
  parse,
  specifiedRules,
  validate,
  type DocumentNode,
  type ExecutionResult,
  type FragmentDefinitionNode,
  type OperationDefinitionNode,
  type SelectionSetNode,
  type ValidationRule,
} from "graphql";
import { ipc } from "@/lib/ipc";
import { resolveMarketplace, type MarketplaceId } from "@/lib/marketplace";
import { ROOTS, type GraphQLContext } from "./builder";
import { schema } from "./schema";

/** How many selection sets deep a document may nest. The deepest path a widget needs today is
 *  three (`decks { value { total } }`); this leaves room for the graph to grow relations. */
export const MAX_DEPTH = 8;

export interface GraphQLRequest {
  query: string;
  variables?: Record<string, unknown> | null;
  operationName?: string | null;
}

export interface RunOptions {
  /**
   * The marketplace a priced field with no `marketplace` argument answers at. `useGraphQL`
   * passes the window's (`useMarketplace().marketplace`, after its host fallback); left out, it
   * is read from the database.
   */
  marketplace?: MarketplaceId;
}

/** A parsed, validated document and the query roots its root fields are stale under. */
export interface PreparedDocument {
  document: DocumentNode | null;
  /** Empty when the document is invalid or reads nothing a write can change. */
  roots: readonly string[];
  errors: readonly GraphQLError[];
}

const QueriesOnly: ValidationRule = (context) => ({
  OperationDefinition(node) {
    if (node.operation !== OperationTypeNode.QUERY) {
      context.reportError(
        new GraphQLError(
          `This graph is read-only: a ${node.operation} operation is not accepted.`,
          { nodes: node },
        ),
      );
    }
  },
});

function fragmentsOf(document: DocumentNode): Map<string, FragmentDefinitionNode> {
  const out = new Map<string, FragmentDefinitionNode>();
  for (const def of document.definitions) {
    if (def.kind === Kind.FRAGMENT_DEFINITION) out.set(def.name.value, def);
  }
  return out;
}

/** The deepest selection set under `set`, counting `set` itself as one. A fragment that spreads
 *  itself is the spec's `NoFragmentCycles` error, so `seen` only stops this walk looping before
 *  that rule's report is read. */
function depthOf(
  set: SelectionSetNode,
  fragments: Map<string, FragmentDefinitionNode>,
  seen: ReadonlySet<string>,
): number {
  let deepest = 0;
  for (const sel of set.selections) {
    if (sel.kind === Kind.FIELD) {
      if (sel.selectionSet) deepest = Math.max(deepest, depthOf(sel.selectionSet, fragments, seen));
    } else if (sel.kind === Kind.INLINE_FRAGMENT) {
      deepest = Math.max(deepest, depthOf(sel.selectionSet, fragments, seen) - 1);
    } else {
      const name = sel.name.value;
      const frag = fragments.get(name);
      if (!frag || seen.has(name)) continue;
      deepest = Math.max(
        deepest,
        depthOf(frag.selectionSet, fragments, new Set([...seen, name])) - 1,
      );
    }
  }
  return deepest + 1;
}

const MaxDepth: ValidationRule = (context) => {
  const fragments = fragmentsOf(context.getDocument());
  return {
    OperationDefinition(node) {
      const depth = depthOf(node.selectionSet, fragments, new Set());
      if (depth > MAX_DEPTH) {
        context.reportError(
          new GraphQLError(`This document nests ${depth} levels deep; the limit is ${MAX_DEPTH}.`, {
            nodes: node,
          }),
        );
      }
    },
  };
};

const RULES: readonly ValidationRule[] = [...specifiedRules, QueriesOnly, MaxDepth];

function operationOf(
  document: DocumentNode,
  operationName: string | null | undefined,
): OperationDefinitionNode | undefined {
  const ops = document.definitions.filter(
    (d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION,
  );
  if (operationName) return ops.find((op) => op.name?.value === operationName);
  return ops.length === 1 ? ops[0] : undefined;
}

/** The names of the root fields an operation selects, through fragments at the top level. */
function rootFieldNames(
  set: SelectionSetNode,
  fragments: Map<string, FragmentDefinitionNode>,
  out: Set<string>,
  seen: Set<string>,
): Set<string> {
  for (const sel of set.selections) {
    if (sel.kind === Kind.FIELD) out.add(sel.name.value);
    else if (sel.kind === Kind.INLINE_FRAGMENT)
      rootFieldNames(sel.selectionSet, fragments, out, seen);
    else if (!seen.has(sel.name.value)) {
      seen.add(sel.name.value);
      const frag = fragments.get(sel.name.value);
      if (frag) rootFieldNames(frag.selectionSet, fragments, out, seen);
    }
  }
  return out;
}

/**
 * The query roots an operation's answer is stale under: the union of its root fields'
 * `invalidatedBy` roots. Introspection (`__schema`, `__typename`) has none — the schema cannot
 * change under a running page.
 */
export function rootsOf(document: DocumentNode, operationName?: string | null): string[] {
  const op = operationOf(document, operationName);
  if (!op) return [];
  const fields = schema.getQueryType()?.getFields() ?? {};
  const roots = new Set<string>();
  for (const name of rootFieldNames(op.selectionSet, fragmentsOf(document), new Set(), new Set())) {
    const declared = fields[name]?.extensions[ROOTS] as readonly string[] | undefined;
    for (const root of declared ?? []) roots.add(root);
  }
  return [...roots].sort();
}

/** Parse and validate once per distinct source: a widget re-renders far more often than its
 *  document changes, and both steps are pure. Bounded, because a generated document is data. */
const PREPARED = new Map<string, PreparedDocument>();
const PREPARED_CAP = 200;

export function prepare(query: string, operationName?: string | null): PreparedDocument {
  const cacheKey = `${operationName ?? ""}\n${query}`;
  const hit = PREPARED.get(cacheKey);
  if (hit) return hit;
  let prepared: PreparedDocument;
  try {
    const document = parse(query);
    const errors = validate(schema, document, RULES);
    prepared =
      errors.length > 0
        ? { document: null, roots: [], errors }
        : { document, roots: rootsOf(document, operationName), errors: [] };
  } catch (e) {
    prepared = {
      document: null,
      roots: [],
      errors: [e instanceof GraphQLError ? e : new GraphQLError(String(e))],
    };
  }
  if (PREPARED.size >= PREPARED_CAP) {
    const oldest = PREPARED.keys().next().value;
    if (oldest !== undefined) PREPARED.delete(oldest);
  }
  PREPARED.set(cacheKey, prepared);
  return prepared;
}

function contextFor(marketplace: MarketplaceId): GraphQLContext {
  const memo = new Map<string, Promise<unknown>>();
  return {
    marketplace,
    once<T>(key: string, load: () => Promise<T>): Promise<T> {
      let hit = memo.get(key) as Promise<T> | undefined;
      if (!hit) {
        hit = load();
        memo.set(key, hit);
      }
      return hit;
    },
  };
}

/** The reader's stored marketplace, resolved as `useMarketplace` resolves it — minus the host
 *  fallback, which needs the feed status and is the hook's to apply. */
async function storedMarketplace(): Promise<MarketplaceId> {
  try {
    return resolveMarketplace(await ipc.getMarketplace()).id;
  } catch {
    return resolveMarketplace(null).id;
  }
}

/**
 * Execute one read. Never rejects for a bad document: a syntax, validation or resolver error is
 * an entry in `errors`, beside whatever `data` the rest of the document answered — the
 * specification's partial-result shape.
 */
export async function runQuery(
  request: GraphQLRequest,
  options: RunOptions = {},
): Promise<ExecutionResult> {
  const prepared = prepare(request.query, request.operationName);
  if (!prepared.document) return { errors: [...prepared.errors] };
  const marketplace = options.marketplace ?? (await storedMarketplace());
  return execute({
    schema,
    document: prepared.document,
    variableValues: request.variables ?? undefined,
    operationName: request.operationName ?? undefined,
    contextValue: contextFor(marketplace),
  });
}
