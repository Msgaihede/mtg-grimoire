import { describe, expect, it } from "vitest";
import { FIELD_NAMES, TABLES } from "../src/projection";
import { ALL_ON, harness, putSettings, putTable, request, token } from "./fake";

/**
 * **The Rust's own documents, ingested** (plan §5): `crates/grimoire-core/src/__golden__/
 * projection.json` is `grimoire_core::integration::projection`'s committed golden — an object
 * keyed by table, every field on — and nothing compiles the two sides together. So this reads it
 * as text, gzips each table as the publisher would, and puts it through the router: a key the
 * Rust started carrying that this Worker's list does not name is a 400 here, before it is a 400
 * on every device's publish.
 *
 * A glob rather than a `?raw` import, so the file's absence is a failure of this case that says
 * so rather than a suite that will not load.
 */
const GOLDEN = import.meta.glob("/crates/grimoire-core/src/__golden__/projection.json", {
  query: "?raw",
  import: "default",
  eager: true,
});

/**
 * A table's document as the golden holds it — the whole document, sent as it is. Its own `table`
 * must be the key it is filed under, or the Worker's refusal would be about the golden's
 * filing rather than the format.
 */
function documentFrom(table: string, held: unknown): Record<string, unknown> {
  expect(held, table).toMatchObject({ v: 1, table });
  return held as Record<string, unknown>;
}

/**
 * The marketplace the golden was projected under — every table's, which must agree — so the
 * store is set up as the group that published it would be: a store on another marketplace
 * refuses the golden as `settings_mismatch`, which is a test of the store, not of the format.
 */
function marketplaceOf(golden: Record<string, unknown>): string {
  const all = new Set(
    Object.values(golden).map((doc) => (doc as { marketplace?: string }).marketplace),
  );
  expect([...all]).toHaveLength(1);
  return String([...all][0]);
}

describe("the Rust golden", () => {
  it("is there, and holds all six tables", () => {
    expect(
      Object.keys(GOLDEN),
      "crates/grimoire-core/src/__golden__/projection.json is missing — the Rust projector's golden",
    ).toHaveLength(1);
    const golden = JSON.parse(Object.values(GOLDEN)[0]) as Record<string, unknown>;
    expect(Object.keys(golden).sort()).toEqual([...TABLES].sort());
  });

  it("is ingested table by table under every field on, each row stored", async () => {
    const golden = JSON.parse(Object.values(GOLDEN)[0] ?? "{}") as Record<string, unknown>;
    const h = harness();
    await putSettings(h.fetch, ALL_ON, "g1", { marketplace: marketplaceOf(golden) });
    expect(Object.keys(golden).length).toBeGreaterThan(0);
    for (const [table, held] of Object.entries(golden)) {
      const doc = documentFrom(table, held);
      expect(doc.fields, table).toEqual([...FIELD_NAMES]);
      const res = await putTable(h.fetch, table, doc);
      expect(res.status, `${table}: ${await res.clone().text()}`).toBe(200);
      expect(((await res.json()) as { rows: number }).rows, table).toBe(
        (doc.rows as unknown[]).length,
      );
    }
    // The golden is meant to exercise every table with at least one row each.
    const answer = await h.fetch(
      request("GET", "/g/g1/projection/digests", { bearer: await token() }),
    );
    const listed = (await answer.json()) as { tables: Record<string, { rows: number }> };
    for (const table of TABLES) expect(listed.tables[table]?.rows, table).toBeGreaterThan(0);
  });

  it("is refused, table by table, with one row carrying a key outside its list", async () => {
    const golden = JSON.parse(Object.values(GOLDEN)[0] ?? "{}") as Record<string, unknown>;
    const h = harness();
    await putSettings(h.fetch, ALL_ON, "g1", { marketplace: marketplaceOf(golden) });
    expect(Object.keys(golden).length).toBeGreaterThan(0);
    for (const [table, held] of Object.entries(golden)) {
      const doc = documentFrom(table, held);
      const rows = doc.rows as Record<string, unknown>[];
      expect(rows.length, table).toBeGreaterThan(0);
      const tampered = { ...doc, rows: [{ ...rows[0], purchasePrice: 1.25 }, ...rows.slice(1)] };
      const res = await putTable(h.fetch, table, tampered);
      expect(res.status, table).toBe(400);
      expect(((await res.json()) as { code: string }).code, table).toBe("bad_projection");
    }
  });
});
