// The relay's D1, as a release changes it (`release.yml`, `relay-deploy` and `share-deploy`):
// each Worker's `schema.sql` is the baseline — the shape production holds, having
// been built from these files by hand — and everything after it is a numbered file in that
// Worker's `migrations/`, which wrangler applies once, in name order, and records in a table of
// its own. The live database was compared with them on 2026-10-11 and matched
// (`docs/reference/ci-and-releases.md`, *What only the owner can do*).
//
// Held here: the baselines do not change (a change to the schema is a new migration, never an
// edit), the files are named so that name order is the order they were written in, the whole
// chain applies to an empty database, and the two bindings name their folder and their table.
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import relaySchema from "../infrastructure/relay/schema.sql?raw";
import shareSchema from "../infrastructure/share-worker/schema.sql?raw";
import relayWrangler from "../infrastructure/relay/wrangler.jsonc?raw";
import shareWrangler from "../infrastructure/share-worker/wrangler.jsonc?raw";

const RELAY = import.meta.glob("/infrastructure/relay/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const SHARE = import.meta.glob("/infrastructure/share-worker/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const BY_HAND = import.meta.glob("/infrastructure/relay/applied-by-hand/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** A file's SHA-256 with its line endings as git stores them, whatever the checkout made of them. */
const baselineHash = (text) =>
  createHash("sha256").update(text.replaceAll("\r\n", "\n")).digest("hex");

/** A folder's `.sql` files as `[name, text]`, in the order wrangler applies them: by name. */
const inOrder = (files) =>
  Object.entries(files)
    .map(([path, text]) => [path.slice(path.lastIndexOf("/") + 1), text])
    .sort(([a], [b]) => (a < b ? -1 : 1));

/** What is wrong with a folder's file names, as sentences — none when name order is write order. */
function orderProblems(names) {
  const out = [];
  const sorted = [...names].sort();
  sorted.forEach((name, i) => {
    const found = /^(\d{4})_[a-z0-9]+(?:-[a-z0-9]+)*\.sql$/.exec(name);
    if (!found) {
      out.push(`${name} is not NNNN_what-it-does.sql`);
    } else if (Number(found[1]) !== i + 1) {
      out.push(`${name} should be number ${String(i + 1).padStart(4, "0")}`);
    }
  });
  return out;
}

/** A config's lines that are not comments. */
const code = (src) =>
  src
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");

describe("the baselines", () => {
  // **A red hash here means `schema.sql` was edited.** Production holds that file's
  // shape (compared 2026-10-11), and nothing re-applies it: put the change in a new file in `migrations/` instead.
  it("are the files production was built from by hand, to the byte", () => {
    expect(baselineHash(relaySchema)).toBe(
      "4ecf91d0da81f08373c7b2d401111fa9584a55a08d3b86e7c092dda1706d89cc",
    );
    expect(baselineHash(shareSchema)).toBe(
      "e1302b39675b1ff18c608b56e590c941e2a9fbd3cbc145d922685ac93d89f0d7",
    );
  });

  it("hashes the same with either line ending", () => {
    expect(baselineHash("a\r\nb\r\n")).toBe(baselineHash("a\nb\n"));
    expect(baselineHash("a\nb\n")).not.toBe(baselineHash("a\nb"));
  });
});

describe("the tracked folders", () => {
  it("name their files so that name order is the order they were written in", () => {
    expect(orderProblems(inOrder(RELAY).map(([name]) => name))).toEqual([]);
    expect(orderProblems(inOrder(SHARE).map(([name]) => name))).toEqual([]);
  });

  it("refuses a name out of the pattern, a number used twice, and a gap", () => {
    expect(orderProblems(["0001_add-a.sql", "0002_add-b.sql"])).toEqual([]);
    expect(orderProblems(["2026-10-12-add-a.sql"])).toEqual([
      "2026-10-12-add-a.sql is not NNNN_what-it-does.sql",
    ]);
    expect(orderProblems(["0001_add-a.sql", "0001_add-b.sql"])).toEqual([
      "0001_add-b.sql should be number 0002",
    ]);
    expect(orderProblems(["0001_add-a.sql", "0003_add-c.sql"])).toEqual([
      "0003_add-c.sql should be number 0002",
    ]);
    expect(orderProblems(["0001_Add_A.sql"])).toEqual(["0001_Add_A.sql is not NNNN_what-it-does.sql"]);
  });

  // The five that were applied by hand are in `schema.sql` already. In the tracked folder
  // wrangler would run each again on the first release, and four of them are `ALTER TABLE`s.
  it("hold none of the migrations that were applied by hand", () => {
    expect(inOrder(BY_HAND).map(([name]) => name)).toEqual([
      "2026-08-30-group-devices.sql",
      "2026-08-30-group-keys.sql",
      "2026-08-31-pairing-rendezvous.sql",
      "2026-09-26-refresh-device.sql",
      "2026-09-28-reconciled-at.sql",
    ]);
    for (const [name] of [...inOrder(RELAY), ...inOrder(SHARE)]) {
      expect(name).not.toMatch(/^2026-/);
    }
  });

  it("apply, baseline first, to a database that has never been migrated", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(relaySchema);
    for (const [, text] of inOrder(RELAY)) db.exec(text);
    db.exec(shareSchema);
    for (const [, text] of inOrder(SHARE)) db.exec(text);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "claim_codes",
        "entitlements",
        "group_devices",
        "group_keys",
        "pairing_rendezvous",
        "shares",
      ]),
    );
    db.close();
  });
});

describe("the two bindings", () => {
  // One database, two Workers, two lists: a table each, so neither list can mark the other's
  // file as applied.
  it("name the tracked folder, and a bookkeeping table of their own", () => {
    expect(code(relayWrangler)).toContain('"migrations_dir": "migrations"');
    expect(code(relayWrangler)).toContain('"migrations_table": "d1_migrations"');
    expect(code(shareWrangler)).toContain('"migrations_dir": "migrations"');
    expect(code(shareWrangler)).toContain('"migrations_table": "d1_migrations_share"');
    expect(code(relayWrangler)).not.toContain("d1_migrations_share");
  });
});
