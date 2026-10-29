import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@grimoire/fake/core"));
vi.mock("@tauri-apps/api/event", () => import("@grimoire/fake/event"));
vi.mock("@tauri-apps/api/window", () => import("@grimoire/fake/window"));

import { installWorld } from "@grimoire/fake/world";
import { isEnumType, isInputObjectType, isObjectType, isUnionType } from "graphql";
import { ROOTS } from "./builder";
import { runQuery } from "./execute";
import { schema, schemaSDL } from "./schema";

const ROOT_FIELDS = schema.getQueryType()?.getFields() ?? {};

describe("the schema", () => {
  it("names the cache roots of every root field, and describes it", () => {
    const missing = Object.values(ROOT_FIELDS).flatMap((field) => {
      const roots = field.extensions[ROOTS] as readonly string[] | undefined;
      const problems: string[] = [];
      if (!roots || roots.length === 0) problems.push(`${field.name}: no invalidatedBy(…) roots`);
      if (!field.description) problems.push(`${field.name}: no description`);
      return problems;
    });
    expect(missing).toEqual([]);
  });

  it("describes every type a reader can meet", () => {
    const undescribed = Object.values(schema.getTypeMap())
      .filter(
        (t) =>
          !t.name.startsWith("__") && !["String", "Int", "Float", "Boolean", "ID"].includes(t.name),
      )
      .filter((t) => isObjectType(t) || isEnumType(t) || isUnionType(t) || isInputObjectType(t))
      .filter((t) => !t.description)
      .map((t) => t.name);
    expect(undescribed).toEqual([]);
  });

  it("is the reviewed SDL beside it", async () => {
    // `pnpm exec vitest run packages/ui/lib/graphql -u` writes it after an intended change.
    await expect(schemaSDL() + "\n").toMatchFileSnapshot("./schema.graphql");
  });
});

/**
 * **Every read the home page makes is a field of the graph** — the prerequisite this layer exists
 * for: a generated widget can show anything a hand-written one shows.
 *
 * The census is the source text, not a list somebody keeps: every `ipc.<name>` the home feature
 * and the hooks its widgets draw from reach is found by pattern, and must be either a read this
 * table maps to a root field that exists, or a write named in {@link WRITES}. A widget that
 * learns a new read fails here, by name, until the graph can answer it too.
 */
const HOME_SOURCES = import.meta.glob<string>(
  [
    "/packages/ui/features/home/**/*.{ts,tsx}",
    "!/packages/ui/features/home/**/*.{test,stories}.{ts,tsx}",
    // The hooks the widgets draw folders, marketplace and release notes from.
    "/packages/ui/features/collection/useCollectionFolders.ts",
    "/packages/ui/features/wishlist/useWishlistFolders.ts",
    "/packages/ui/lib/useMarketplace.ts",
    "/packages/ui/lib/useReleaseHistory.ts",
  ],
  { query: "?raw", import: "default", eager: true },
);

/** The read → the root field that answers it. */
const READS: Readonly<Record<string, string>> = {};

/** Calls in those files that write, subscribe, or are not the reader's data — never a field. */
const WRITES: Readonly<Record<string, string>> = {};

describe("home widget coverage", () => {
  const found = new Set<string>();
  for (const text of Object.values(HOME_SOURCES)) {
    for (const m of text.matchAll(/\bipc\.([A-Za-z]+)\b/g)) found.add(m[1]);
  }

  it("finds the widgets' reads at all", () => {
    expect(found.size).toBeGreaterThan(20);
  });

  it("maps every read to a root field, and names every write", () => {
    const unaccounted = [...found].filter((name) => !(name in READS) && !(name in WRITES)).sort();
    expect(unaccounted).toEqual([]);
  });

  it("maps only to root fields that exist", () => {
    const dangling = Object.entries(READS)
      .filter(([, field]) => !(field in ROOT_FIELDS))
      .map(([read, field]) => `${read} → ${field}`);
    expect(dangling).toEqual([]);
  });
});

describe("against the fake backend", () => {
  it("answers every widget's document without an error", async () => {
    installWorld({ seed: "starter" });
    const result = await runQuery({ query: WIDGET_DOCUMENT }, { marketplace: "tcgplayer" });
    expect(result.errors ?? []).toEqual([]);
  });
});

/** One document reading everything the home widgets draw, at full depth. */
const WIDGET_DOCUMENT = /* GraphQL */ `
  {
    marketplace {
      id
      currency
    }
    scannerTray {
      key
      name
      quantity
      finish
    }
    releaseNotes(limit: 3) {
      version
      notes
      publishedAt
    }
  }
`;
