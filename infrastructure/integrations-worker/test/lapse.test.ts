import { describe, expect, it } from "vitest";
import worker from "../src/worker";
import { LAPSE_BUDGET, sweepLapsed } from "../src/lapse";
import { ALL_OFF, entitle, harness } from "./fake";

/**
 * The daily lapse pass (`src/lapse.ts`): a store whose group no serving membership names is
 * emptied and its row forgotten; every other store is left exactly as it was. The relay's D1 is
 * real SQLite here, so the `NOT IN` meets SQLite's own NULL rule — the case the share Worker's
 * pass was once frozen by.
 */

/** The instant every pass below is judged at. */
const NOW = 1_760_000_000_000;

type H = ReturnType<typeof harness>;

/** A store for `group`, made as `PUT …/settings` makes one: its row first, then the object. */
async function storeFor(h: H, group: string, createdAt = NOW) {
  h.db
    .prepare("INSERT INTO integration_groups (group_id, created_at) VALUES (?, ?)")
    .run(group, createdAt);
  await h.stores
    .objectOf(group)
    .store.settings(group, { fields: ALL_OFF, marketplace: "tcgplayer" }, true, createdAt);
}

const rows = (h: H) =>
  h.db
    .prepare("SELECT group_id FROM integration_groups ORDER BY group_id")
    .all()
    .map((row) => row.group_id);

const hasStore = (h: H, group: string) =>
  h.stores
    .objectOf(group)
    .storage.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all().length > 0;

describe("the lapse pass", () => {
  it("empties the stores of the groups no serving membership names, and only those", async () => {
    const h = harness(); // `g1` is entitled, active.
    entitle(h.db, "sub-2", "g2", "dead");
    entitle(h.db, "sub-3", "g3", "grace", NOW + 1);
    entitle(h.db, "sub-4", "g4", "grace", NOW - 1);
    entitle(h.db, "sub-6", "g6", "grace", NOW); // the deadline instant is still inside
    // ⚠️ A subscriber who has claimed no group: a NULL `group_id`, which in a `NOT IN` list would
    // make the condition NULL for every row and freeze the pass, silently.
    entitle(h.db, "sub-7", null);
    for (const group of ["g1", "g2", "g3", "g4", "g5", "g6"]) await storeFor(h, group);

    // `g5` has no entitlement at all — a subscriber who moved their binding elsewhere.
    expect((await sweepLapsed(h.env, NOW)).sort()).toEqual(["g2", "g4", "g5"]);
    expect(rows(h)).toEqual(["g1", "g3", "g6"]);
    for (const group of ["g2", "g4", "g5"]) expect(hasStore(h, group), group).toBe(false);
    for (const group of ["g1", "g3", "g6"]) expect(hasStore(h, group), group).toBe(true);

    // The next pass finds nothing more to do.
    expect(await sweepLapsed(h.env, NOW)).toEqual([]);
  });

  it(`empties at most ${LAPSE_BUDGET} a pass, the oldest first, and the rest on the next`, async () => {
    const h = harness();
    const lapsed = Array.from(
      { length: LAPSE_BUDGET + 5 },
      (_, i) => `x${String(i).padStart(2, "0")}`,
    );
    // Made newest first, so the order the pass takes is the stamp's, not the insert's.
    for (const [at, group] of [...lapsed].reverse().entries()) await storeFor(h, group, NOW - at);

    // `x00` is the oldest store and `x29` the newest.
    expect(await sweepLapsed(h.env, NOW)).toEqual(lapsed.slice(0, LAPSE_BUDGET));
    expect(rows(h)).toEqual(lapsed.slice(LAPSE_BUDGET));
    expect(await sweepLapsed(h.env, NOW)).toEqual(lapsed.slice(LAPSE_BUDGET));
    expect(rows(h)).toEqual([]);
  });

  it("keeps the row of a store whose object is down, and asks it again next time", async () => {
    const h = harness();
    await storeFor(h, "g2");
    await storeFor(h, "g3");
    h.stores.failing.add("g2");
    expect(await sweepLapsed(h.env, NOW)).toEqual(["g3"]);
    expect(rows(h)).toEqual(["g2"]);
    h.stores.failing.delete("g2");
    expect(await sweepLapsed(h.env, NOW)).toEqual(["g2"]);
    expect(rows(h)).toEqual([]);
  });

  /**
   * The review's race (2026-10-25) on the pass's side: a device switches integrations on between
   * the pass's `deleteAll` and its delete of the row. The store it made must keep its row, or no
   * later pass could find it.
   */
  it("gives a store switched on again mid-pass its row back, and empties it on a later pass", async () => {
    const h = harness();
    await storeFor(h, "g2");
    const store = h.stores.objectOf("g2").store;
    const deleteAll = store.deleteAll.bind(store);
    store.deleteAll = async () => {
      await deleteAll();
      await store.settings("g2", { fields: ALL_OFF, marketplace: "tcgplayer" }, true, NOW);
    };
    expect(await sweepLapsed(h.env, NOW)).toEqual(["g2"]);
    expect(hasStore(h, "g2")).toBe(true);
    expect(rows(h)).toEqual(["g2"]);

    store.deleteAll = deleteAll;
    expect(await sweepLapsed(h.env, NOW)).toEqual(["g2"]);
    expect(hasStore(h, "g2")).toBe(false);
    expect(rows(h)).toEqual([]);
  });

  it("keeps the row of an emptied object it cannot ask again, as of one it could not empty", async () => {
    const h = harness();
    await storeFor(h, "g2");
    const store = h.stores.objectOf("g2").store;
    store.exists = () => Promise.reject(new Error("the object is down"));
    expect(await sweepLapsed(h.env, NOW)).toEqual(["g2"]);
    expect(rows(h)).toEqual(["g2"]);
  });

  it("is what the Worker's cron runs", async () => {
    const h = harness();
    await storeFor(h, "g2");
    await worker.scheduled({} as ScheduledController, h.env);
    expect(rows(h)).toEqual([]);
    expect(hasStore(h, "g2")).toBe(false);
  });
});
