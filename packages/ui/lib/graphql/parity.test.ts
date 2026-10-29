import { describe, expect, it } from "vitest";
import {
  buildSchema,
  isEnumType,
  isObjectType,
  isScalarType,
  Kind,
  print,
  printSchema,
  type GraphQLField,
  type GraphQLNamedType,
} from "graphql";
import { ROOTS } from "./builder";
import { schema as built } from "./schema";

/**
 * **The Rust graph is the page's graph, field for field, for everything it has ported.**
 *
 * The desktop answers `graphql_query` from `crates/grimoire-graph`; every story and suite answers
 * it from this folder's schema (through the fake). A document is written once — by a widget, or
 * by a model the MCP server hands the Rust schema to — so the two must agree on every name, type,
 * argument and default the Rust side has. The Rust side has *less* while the port runs: a type,
 * field or argument missing there is the port's progress; one that exists there and differs, or
 * exists only there, is a bug in one of them.
 *
 * **One argument differs on purpose**: a card search. The page's graph took `query: String` in
 * Scryfall's syntax, which only TypeScript parses; the Rust graph takes `filters: CardFilterInput`,
 * the core's own `CardFilters` structured (the owner's decision, 2026-10-29). {@link RENAMED_ARGS}
 * is that exception and nothing else.
 *
 * The Rust printout is `crates/grimoire-graph/schema.graphql`, held to the crate's code by its own
 * golden test (`the_printed_schema_is_the_reviewed_one`). Descriptions are not compared — each
 * side words its own.
 */
const RUST_SDL = Object.values(
  import.meta.glob<string>("/crates/grimoire-graph/schema.graphql", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
)[0];

const rust = buildSchema(RUST_SDL);

/**
 * The page's graph **read back from its own printout**, not the object Pothos built: a schema
 * built in code has no syntax nodes, so every argument's default would read as absent and any
 * Rust default would fail to match it. Printed and re-read, both sides carry their defaults the
 * same way. The cache roots are not in the printout — they are Pothos extensions — so they are
 * read off `built`.
 */
const page = buildSchema(printSchema(built));

/** A Rust argument → the page argument it replaces, compared by presence only. */
const RENAMED_ARGS: Readonly<Record<string, string>> = { filters: "query" };

const BUILT_IN = new Set(["String", "Int", "Float", "Boolean", "ID"]);
const rustTypes = Object.values(rust.getTypeMap()).filter(
  (t) => !t.name.startsWith("__") && !BUILT_IN.has(t.name),
);

function kindOf(t: GraphQLNamedType): string {
  if (isObjectType(t)) return "object";
  if (isEnumType(t)) return "enum";
  if (isScalarType(t)) return "scalar";
  return "other";
}

/** A field's signature, descriptions aside: its type and every argument with its default. */
function signature(field: GraphQLField<unknown, unknown>, only?: ReadonlySet<string>): string {
  const args = field.args
    .filter((a) => !only || only.has(a.name))
    .map((a) => {
      const dflt = a.astNode?.defaultValue ? ` = ${print(a.astNode.defaultValue)}` : "";
      return `${a.name}: ${String(a.type)}${dflt}`;
    })
    .sort();
  return `${field.name}(${args.join(", ")}): ${String(field.type)}`;
}

/** The roots a Rust root field's `@invalidatedBy` names. */
function rustRoots(field: GraphQLField<unknown, unknown>): string[] {
  const directive = field.astNode?.directives?.find((d) => d.name.value === "invalidatedBy");
  const list = directive?.arguments?.find((a) => a.name.value === "roots")?.value;
  if (!list || list.kind !== Kind.LIST) return [];
  return list.values.flatMap((v) => (v.kind === Kind.STRING ? [v.value] : [])).sort();
}

describe("the Rust graph against the page's", () => {
  it("has ported something", () => {
    expect(Object.keys(rust.getQueryType()?.getFields() ?? {}).length).toBeGreaterThan(0);
  });

  it("names only types the page's graph has, of the same kind", () => {
    const wrong = rustTypes.flatMap((t) => {
      const twin = page.getType(t.name);
      if (!twin) return [`${t.name}: only in Rust`];
      return kindOf(twin) === kindOf(t)
        ? []
        : [`${t.name}: ${kindOf(t)} in Rust, ${kindOf(twin)} on the page`];
    });
    expect(wrong).toEqual([]);
  });

  it("spells every ported field, argument and default as the page does", () => {
    const wrong = rustTypes.filter(isObjectType).flatMap((t) => {
      const twin = page.getType(t.name);
      if (!twin || !isObjectType(twin)) return [];
      const fields = twin.getFields();
      return Object.values(t.getFields()).flatMap((f) => {
        const mine = fields[f.name];
        if (!mine) return [`${t.name}.${f.name}: only in Rust`];
        const renamed = f.args.filter((a) => a.name in RENAMED_ARGS);
        const unmatched = renamed.filter(
          (a) => !mine.args.some((m) => m.name === RENAMED_ARGS[a.name]),
        );
        if (unmatched.length > 0) {
          return [`${t.name}.${f.name}: ${unmatched[0].name} replaces no page argument`];
        }
        const argNames = new Set(
          f.args.filter((a) => !(a.name in RENAMED_ARGS)).map((a) => a.name),
        );
        const missing = [...argNames].filter((n) => !mine.args.some((a) => a.name === n));
        if (missing.length > 0)
          return [`${t.name}.${f.name}: arguments only in Rust: ${missing.join(", ")}`];
        const ours = signature(mine, argNames);
        const theirs = signature(f, argNames);
        return ours === theirs ? [] : [`${t.name}: Rust ${theirs} — page ${ours}`];
      });
    });
    expect(wrong).toEqual([]);
  });

  it("has every enum's values exactly", () => {
    const wrong = rustTypes.filter(isEnumType).flatMap((t) => {
      const twin = page.getType(t.name);
      if (!twin || !isEnumType(twin)) return [];
      const a = t
        .getValues()
        .map((v) => v.name)
        .sort();
      const b = twin
        .getValues()
        .map((v) => v.name)
        .sort();
      return JSON.stringify(a) === JSON.stringify(b)
        ? []
        : [`${t.name}: Rust ${a.join("|")} — page ${b.join("|")}`];
    });
    expect(wrong).toEqual([]);
  });

  it("re-asks every ported root field under the same cache roots", () => {
    const pageFields = built.getQueryType()?.getFields() ?? {};
    const wrong = Object.values(rust.getQueryType()?.getFields() ?? {}).flatMap((f) => {
      const ours = [
        ...((pageFields[f.name]?.extensions[ROOTS] as string[] | undefined) ?? []),
      ].sort();
      const theirs = rustRoots(f);
      return JSON.stringify(ours) === JSON.stringify(theirs)
        ? []
        : [`${f.name}: Rust ${theirs.join(",") || "none"} — page ${ours.join(",") || "none"}`];
    });
    expect(wrong).toEqual([]);
  });
});
