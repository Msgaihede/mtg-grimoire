import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@grimoire/fake/core"));
vi.mock("@tauri-apps/api/event", () => import("@grimoire/fake/event"));
vi.mock("@tauri-apps/api/window", () => import("@grimoire/fake/window"));

import { installWorld } from "@grimoire/fake/world";
import { parse } from "graphql";
import { ipc } from "@/lib/ipc";
import { MAX_DEPTH, prepare, rootsOf, runQuery } from "./execute";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runQuery", () => {
  it("answers a document from the fake backend, at the marketplace it is handed", async () => {
    installWorld({ seed: "starter" });
    const result = await runQuery(
      { query: "{ marketplace { id currency } scannerTray { key } }" },
      { marketplace: "cardmarket" },
    );
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      marketplace: { id: "cardmarket", currency: "eur" },
      scannerTray: [],
    });
  });

  it("reads the stored marketplace when it is handed none", async () => {
    installWorld({ seed: "starter" });
    await ipc.setMarketplace("cardkingdom");
    const result = await runQuery({ query: "{ marketplace { id } }" });
    expect(result.data).toEqual({ marketplace: { id: "cardkingdom" } });
  });

  it("refuses a mutation and a subscription before anything runs", async () => {
    for (const op of ["mutation { anything }", "subscription { anything }"]) {
      const result = await runQuery({ query: op });
      expect(result.data).toBeUndefined();
      expect(result.errors?.map((e) => e.message)).toContainEqual(
        expect.stringMatching(/read-only/),
      );
    }
  });

  it("answers a syntax error in `errors` rather than rejecting", async () => {
    const result = await runQuery({ query: "{ marketplace { id " });
    expect(result.data).toBeUndefined();
    expect(result.errors).toHaveLength(1);
    expect(result.errors?.[0].message).toMatch(/Syntax Error/);
  });

  it(`refuses a document nested deeper than ${MAX_DEPTH} levels, counting through fragments`, async () => {
    // Introspection is the one cyclic corner of any schema, which makes it the honest probe.
    const nest = (n: number): string => (n === 0 ? "name" : `ofType { ${nest(n - 1)} }`);
    const ok = prepare(`{ __type(name: "Query") { ${nest(MAX_DEPTH - 2)} } }`);
    expect(ok.errors).toEqual([]);
    const deep = prepare(
      `{ __type(name: "Query") { ...F } } fragment F on __Type { ${nest(MAX_DEPTH - 1)} }`,
    );
    expect(deep.errors.map((e) => e.message)).toEqual([
      `This document nests ${MAX_DEPTH + 1} levels deep; the limit is ${MAX_DEPTH}.`,
    ]);
  });

  it("leaves a backend refusal as the backend's sentence, not graphql-js's wrapping of it", async () => {
    installWorld({ seed: "starter" });
    vi.spyOn(ipc, "scannerTray").mockRejectedValue("The scanner tray could not be read.");
    const result = await runQuery({ query: "{ marketplace { id } scannerTray { key } }" });
    // The rest of the document still answers — a root field is nullable for exactly this.
    expect(result.data).toEqual({ marketplace: { id: "tcgplayer" }, scannerTray: null });
    expect(result.errors?.map((e) => e.message)).toEqual(["The scanner tray could not be read."]);
    expect(result.errors?.[0].path).toEqual(["scannerTray"]);
  });
});

describe("rootsOf", () => {
  it("unions the roots of every root field, through fragments and inline fragments", () => {
    const doc = parse(`
      query Board { ...Tray ... on Query { marketplace { id } } releaseNotes { version } }
      fragment Tray on Query { scannerTray { key } }
    `);
    expect(rootsOf(doc)).toEqual(["bundledReleaseHistory", "marketplace", "scanner"]);
  });

  it("names no root for introspection, and none for an operation it cannot pick", () => {
    expect(rootsOf(parse("{ __typename __schema { queryType { name } } }"))).toEqual([]);
    expect(
      rootsOf(parse("query A { marketplace { id } } query B { scannerTray { key } }")),
    ).toEqual([]);
    expect(
      rootsOf(parse("query A { marketplace { id } } query B { scannerTray { key } }"), "B"),
    ).toEqual(["scanner"]);
  });
});
