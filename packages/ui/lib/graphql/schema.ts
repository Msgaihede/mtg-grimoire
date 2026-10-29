/**
 * The graph, built once: every domain file registers on `./builder.ts`, and this file is the one
 * place that imports them all and asks Pothos for the schema.
 *
 * **One domain file per `lib/ipc/<domain>.ts`**, and a root field lives in the file named after
 * the `ipc` file its wrapper is in — `collectionValueHistory` is in `home.ts` because
 * `ipc.collectionValueHistory` is — so where a field goes is never a judgment call. An object
 * type lives with the `ipc` file its interface is declared in, for the same reason.
 */
import {
  isNonNullType,
  isObjectType,
  printSchema,
  type GraphQLFieldResolver,
  type GraphQLSchema,
} from "graphql";
import { ipcError } from "@/lib/ipc";
import { builder } from "./builder";
import "./schema/enums";
import "./schema/app";
import "./schema/cards";
import "./schema/collection";
import "./schema/decks";
import "./schema/entryTags";
import "./schema/home";
import "./schema/prefs";
import "./schema/scanner";
import "./schema/tags";
import "./schema/wishlist";

/**
 * Every rejection a resolver meets leaves as an `Error` carrying the backend's sentence.
 *
 * An `ipc` wrapper rejects with a plain string (`invoke.ts` has why), and graphql-js reports a
 * non-`Error` throw as "Unexpected error value: …" — the sentence wrapped in a sentence about the
 * wrapping. This turns it back into the one shape a caller already renders (`ipcError`).
 */
function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(ipcError(e));
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function withPlainErrors(schema: GraphQLSchema): GraphQLSchema {
  for (const type of Object.values(schema.getTypeMap())) {
    if (!isObjectType(type) || type.name.startsWith("__")) continue;
    for (const field of Object.values(type.getFields())) {
      const resolve: GraphQLFieldResolver<unknown, unknown> | undefined = field.resolve;
      if (!resolve) continue;
      field.resolve = (source, args, context, info) => {
        try {
          const out = resolve(source, args, context, info);
          return isThenable(out)
            ? Promise.resolve(out).catch((e: unknown) => Promise.reject(asError(e)))
            : out;
        } catch (e) {
          throw asError(e);
        }
      };
    }
  }
  return schema;
}

/**
 * **Every root field is nullable, whatever its domain file declared.** A widget's document reads
 * several root fields at once, and a non-null field that fails nulls its parent — for a root
 * field, the whole answer. So one refused read (a price feed that has never been fetched, a
 * deck deleted under a stale id) would blank a widget that could have drawn everything else.
 * Nullable at the root, a failure is that field's `null` and its entry in `errors`, and the rest
 * of the document stands. Below the root the domain files' nullability is the `ipc` shape's and
 * is left alone. Done here once rather than in every domain file, each of which would have to remember.
 */
function withNullableRoots(schema: GraphQLSchema): GraphQLSchema {
  for (const field of Object.values(schema.getQueryType()?.getFields() ?? {})) {
    if (isNonNullType(field.type)) field.type = field.type.ofType;
  }
  return schema;
}

export const schema: GraphQLSchema = withNullableRoots(
  withPlainErrors(builder.toSchema({ sortSchema: true })),
);

/**
 * The schema as SDL — what a model writing a widget is handed, and what `schema.graphql` beside
 * this file is checked against (`graphql.test.ts`), so a change to the graph is a reviewed diff.
 */
export function schemaSDL(): string {
  return printSchema(schema);
}
