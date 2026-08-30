import { describe, expect, it } from "vitest";
import { fakeEnv, fakeEnvOver, fakeTables, type Tables } from "./fakeD1";
import {
  admitDevice,
  authIsCurrent,
  authIsRecent,
  currentManifest,
  equalsConstantTime,
  forgetGroup,
  keepOnly,
  liveDeviceCount,
  recordRotation,
  seedGroup,
} from "./groupauth";

// ---------------------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------------------

describe("equalsConstantTime", () => {
  it("matches a string against itself and against nothing else", () => {
    expect(equalsConstantTime("a1b2", "a1b2")).toBe(true);
    expect(equalsConstantTime("a1b2", "a1b3")).toBe(false);
    // A prefix is not a match, which is the case a naive loop over the shorter string gets wrong.
    expect(equalsConstantTime("a1b2", "a1b")).toBe(false);
    expect(equalsConstantTime("a1b", "a1b2")).toBe(false);
  });
});

describe("recordRotation", () => {
  it("refuses a rotation that does not advance the epoch", async () => {
    const env = fakeEnv("g1");
    await seedGroup(env, "g1", 0, "auth-0");

    // The epoch the group is already standing on, which is the epoch a device that was just
    // removed still knows the auth for.
    expect(await recordRotation(env, "g1", 0, "auth-0b", {})).toBe(false);
    expect(await recordRotation(env, "g1", 1, "auth-1", { d1: "blob" })).toBe(true);
    expect(await recordRotation(env, "g1", 1, "auth-1b", {})).toBe(false);

    // **A refused rotation must leave no trace, and this is the half that matters.** Writing the
    // auth without the epoch row would hand the group's current credential to the caller that
    // was just refused — which is the removed device re-entering by another door.
    expect(await currentManifest(env, "g1")).toEqual({ epoch: 1, keys: { d1: "blob" } });
    expect(await authIsCurrent(env, "g1", "auth-1")).toBe(true);
    expect(await authIsCurrent(env, "g1", "auth-1b")).toBe(false);
    expect(await authIsRecent(env, "g1", "auth-1b")).toBe(false);
  });

  it("keeps a manifest per epoch and answers the newest", async () => {
    const env = fakeEnv("g1");
    await seedGroup(env, "g1", 0, "auth-0");
    await recordRotation(env, "g1", 1, "auth-1", { desk: "blob-a", phone: "blob-b" });
    await recordRotation(env, "g1", 2, "auth-2", { desk: "blob-c" });

    // The phone is off the epoch-2 manifest, which is the entirety of how the group is told it
    // was removed: the key set IS the roster.
    expect(await currentManifest(env, "g1")).toEqual({ epoch: 2, keys: { desk: "blob-c" } });
  });
});

describe("the epoch window", () => {
  it("accepts a recent auth and refuses one that has aged out", async () => {
    const env = fakeEnv("g1");
    await seedGroup(env, "g1", 0, "auth-0");
    for (let e = 1; e <= 9; e += 1) {
      expect(await recordRotation(env, "g1", e, `auth-${e}`, {})).toBe(true);
    }

    // The current auth is the one `/token`'s group door takes, and only that one.
    expect(await authIsCurrent(env, "g1", "auth-9")).toBe(true);
    expect(await authIsCurrent(env, "g1", "auth-8")).toBe(false);

    // `/keys` takes the stale one, because a device that is behind a rotation and a device that
    // was removed present the same stale auth — the manifest is what tells them apart.
    expect(await authIsRecent(env, "g1", "auth-9")).toBe(true);
    expect(await authIsRecent(env, "g1", "auth-8")).toBe(true);

    // **`auth-1` is the assertion that pins the window's width, and `auth-0` alone does not.**
    // Eight rows kept at epoch 9 means epochs 2 through 9; a ninth would reach back to epoch 1.
    // Epoch 0 has fallen outside both, so a test that only asserted on it would stay green with
    // the window one epoch wider than this design says it is.
    expect(await authIsRecent(env, "g1", "auth-2")).toBe(true);
    expect(await authIsRecent(env, "g1", "auth-1")).toBe(false);
    expect(await authIsRecent(env, "g1", "auth-0")).toBe(false);
  });
});

describe("one group's auth never opens another", () => {
  it("keeps two groups apart even when they were seeded with the same auth", async () => {
    const env = fakeEnv("g1", "g2");
    await seedGroup(env, "g1", 0, "auth-0");
    await seedGroup(env, "g2", 0, "auth-0");

    expect(await authIsCurrent(env, "g1", "auth-0")).toBe(true);
    expect(await authIsCurrent(env, "g2", "auth-0")).toBe(true);

    // g1 rotates. Every lookup is by (group, auth) and never by auth alone — an auth that
    // opened any group would open every group it happened to collide with, and `relay_auth` is
    // derived from a group key that a restore-from-backup could in principle repeat.
    await recordRotation(env, "g1", 1, "auth-1", { d1: "blob" });

    expect(await authIsCurrent(env, "g1", "auth-1")).toBe(true);
    expect(await authIsCurrent(env, "g2", "auth-1")).toBe(false);
    expect(await authIsRecent(env, "g2", "auth-1")).toBe(false);

    // And g2 is exactly where it was: still at its claim epoch, still holding nothing.
    expect(await currentManifest(env, "g2")).toEqual({ epoch: 0, keys: {} });
    expect(await currentManifest(env, "g1")).toEqual({ epoch: 1, keys: { d1: "blob" } });
  });
});

describe("seedGroup", () => {
  it("registers a claimed group at its epoch with an empty manifest", async () => {
    const env = fakeEnv("g1");
    await seedGroup(env, "g1", 3, "auth-3");

    // **The empty manifest is the correct answer and not a placeholder**, and it is safe only
    // because a reader compares epochs before consulting it (spec §2.3). Equal epochs mean
    // nothing to do; without that guard this row is the one that makes every device in a
    // healthy, never-rotated group conclude it has been removed.
    expect(await currentManifest(env, "g1")).toEqual({ epoch: 3, keys: {} });
    expect(await authIsCurrent(env, "g1", "auth-3")).toBe(true);
    expect(await authIsRecent(env, "g1", "auth-3")).toBe(true);
  });

  it("does not blank a manifest the relay is already holding", async () => {
    // The re-claim of spec §4: the reader sold the laptop that held the refresh secret and
    // connected Patreon again on another device, which claims the same group at the epoch that
    // group has reached. Writing over the row would replace a live key distribution with an
    // empty one, which is every remaining device reading itself as removed.
    const env = fakeEnv("g1");
    await seedGroup(env, "g1", 0, "auth-0");
    await recordRotation(env, "g1", 1, "auth-1", { desk: "blob" });

    await seedGroup(env, "g1", 1, "auth-1");

    expect(await currentManifest(env, "g1")).toEqual({ epoch: 1, keys: { desk: "blob" } });
    expect(await authIsCurrent(env, "g1", "auth-1")).toBe(true);
  });
});

describe("a group the relay has never been told about", () => {
  it("answers null rather than an empty manifest", async () => {
    const env = fakeEnv("g1");
    await seedGroup(env, "g1", 0, "auth-0");

    // `null` is a 404 and says "no such group"; an empty manifest says "this group is at epoch N
    // and has never rotated". Collapsing them makes a typo in a group id look like a healthy
    // group, and a healthy group look like a typo.
    expect(await currentManifest(env, "nope")).toBeNull();
    expect(await authIsCurrent(env, "nope", "auth-0")).toBe(false);
    expect(await authIsRecent(env, "nope", "auth-0")).toBe(false);
  });
});

describe("an unreadable manifest", () => {
  it("throws rather than reading as an empty one", async () => {
    const env = fakeEnv("g1");
    await seedGroup(env, "g1", 0, "auth-0");
    await recordRotation(env, "g1", 1, "auth-1", { desk: "blob" });
    await env.DB.prepare(`UPDATE group_keys SET keys = ? WHERE group_id = ?`)
      .bind("{not json", "g1")
      .run();

    // The two failures are not the same size. A throw is a 500 on `/keys` and every device
    // stalls where it is, which is recoverable by fixing the row; `{}` at a higher epoch is
    // positive evidence of removal, which every device in the group acts on at once.
    await expect(currentManifest(env, "g1")).rejects.toThrow(/manifest/);
  });
});

// ---------------------------------------------------------------------------------------
// The device roll
// ---------------------------------------------------------------------------------------

/** Fixed, so nothing below depends on when the suite runs. */
const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

/** A first-seen far enough from every other number here to be recognisable when it survives. */
const JOINED = 1_700_000_000_000;

/**
 * ⚠️ **Ninety days is spelled out rather than imported from `DEVICE_TTL_MS`, and that is the
 * whole of what makes these assertions worth anything.** A test that built its stamps out of the
 * constant it is checking would move both edges together the moment the constant moved: double
 * the TTL and the row this file calls "too old" is re-derived as ninety *fresh* days old, so the
 * assertion stays green against a window twice the width the design asks for — which is exactly
 * the mutation the cap has to survive. The literal is the policy stated a second time,
 * independently, and independence is the only arrangement in which the two can be seen to
 * disagree.
 *
 * `EDGE` is the row seen exactly ninety days ago, which the design keeps: the comparison is
 * `last_seen < now - DEVICE_TTL_MS`, so the constant is a duration rather than an off-by-one.
 */
const FRESH = NOW - 89 * DAY;
const EDGE = NOW - 90 * DAY;
const STALE = NOW - 91 * DAY;

function seat(tables: Tables, group: string, device: string, lastSeen: number): void {
  tables.group_devices.push({
    group_id: group,
    device_id: device,
    first_seen: JOINED,
    last_seen: lastSeen,
  });
}

/** Which devices a group is holding, as the table actually has them. */
function idsIn(tables: Tables, group: string): string[] {
  return tables.group_devices
    .filter((row) => row.group_id === group)
    .map((row) => String(row.device_id))
    .sort();
}

describe("the device cap", () => {
  it("admits five devices and refuses a sixth, writing nothing for the refused one", async () => {
    const tables = fakeTables({ groups: ["g1"] });
    const env = fakeEnvOver(tables);

    for (const device of ["d1", "d2", "d3", "d4", "d5"]) {
      expect(await admitDevice(env, "g1", device, NOW)).toBe(true);
    }
    expect(await liveDeviceCount(env, "g1", NOW)).toBe(5);

    expect(await admitDevice(env, "g1", "d6", NOW)).toBe(false);

    // **A refused device must leave no row.** One that moved a `last_seen` on its way to being
    // turned away would be admitted by the very next call, and one that inserted would have
    // taken the slot it was told it could not have.
    expect(idsIn(tables, "g1")).toEqual(["d1", "d2", "d3", "d4", "d5"]);
  });

  it("re-admits a device the group already holds, even when the group is full", async () => {
    const tables = fakeTables({ groups: ["g1"] });
    const env = fakeEnvOver(tables);
    for (const device of ["d1", "d2", "d3", "d4", "d5"]) seat(tables, "g1", device, FRESH);

    // The whole household is paired and the fifth device was admitted months ago. Every sync any
    // of them does comes back through here, and a cap that counted a returning device as a new
    // one would refuse all five of them for ever.
    expect(await admitDevice(env, "g1", "d3", NOW)).toBe(true);

    expect(idsIn(tables, "g1")).toEqual(["d1", "d2", "d3", "d4", "d5"]);
    const row = tables.group_devices.find((one) => one.device_id === "d3");
    expect(row?.last_seen).toBe(NOW);
    // `first_seen` is the one column an upsert must not touch: it is what says when this device
    // joined, and a `SET` list that rewrote it would answer "just now" for every device.
    expect(row?.first_seen).toBe(JOINED);
  });

  it("counts what the ninety-day window holds, and deletes what it does not", async () => {
    const tables = fakeTables({ groups: ["g1"] });
    const env = fakeEnvOver(tables);
    seat(tables, "g1", "drawer", FRESH);
    seat(tables, "g1", "edge", EDGE);
    seat(tables, "g1", "sold", STALE);

    expect(await liveDeviceCount(env, "g1", NOW)).toBe(2);

    // Counted *and* pruned, in that order and both. A count that filtered in JavaScript would
    // answer 2 and leave the row on disk for ever, which is the half of the failure that never
    // shows up in a count.
    expect(idsIn(tables, "g1")).toEqual(["drawer", "edge"]);
  });

  it("gives a wiped device's slot back rather than locking the reader out", async () => {
    const tables = fakeTables({ groups: ["g1"] });
    const env = fakeEnvOver(tables);
    for (const device of ["d1", "d2", "d3", "d4"]) seat(tables, "g1", device, FRESH);
    // The data folder was wiped a season ago, so this id was replaced rather than re-used: no
    // manifest names it and no rotation will ever free it. Without the TTL, five reinstalls
    // exhaust a reader's own account permanently and the only way out is a hand edit of D1.
    seat(tables, "g1", "wiped", STALE);

    expect(await liveDeviceCount(env, "g1", NOW)).toBe(4);
    expect(await admitDevice(env, "g1", "reinstalled", NOW)).toBe(true);
    expect(idsIn(tables, "g1")).toEqual(["d1", "d2", "d3", "d4", "reinstalled"]);
  });

  it("counts and prunes one group at a time", async () => {
    const tables = fakeTables({ groups: ["g1", "g2"] });
    const env = fakeEnvOver(tables);
    for (const device of ["a", "b", "c", "d", "e"]) seat(tables, "g2", device, FRESH);
    seat(tables, "g2", "ancient", STALE);

    // g2 is full and one of its rows is past the TTL. Neither fact is g1's business: the count
    // is per group because a group is a subscription, and a sweep that crossed groups would
    // prune rows for a group nobody had asked about.
    expect(await liveDeviceCount(env, "g1", NOW)).toBe(0);
    expect(await admitDevice(env, "g1", "only", NOW)).toBe(true);
    expect(idsIn(tables, "g2")).toEqual(["a", "ancient", "b", "c", "d", "e"]);
  });
});

describe("keepOnly", () => {
  it("deletes exactly the devices the manifest does not name, and inserts none", async () => {
    const tables = fakeTables({ groups: ["g1", "g2"] });
    const env = fakeEnvOver(tables);
    seat(tables, "g1", "desk", FRESH);
    seat(tables, "g1", "phone", FRESH);
    seat(tables, "g1", "laptop", FRESH);
    // ⚠️ **g2 holds a device named `phone` deliberately**, and that is the one thing making the
    // cross-group assertion below able to fail: `phone` is the row this call deletes from g1, so
    // a `DELETE … WHERE device_id = ?` that had lost its `group_id` would take g2's with it.
    // Seated under any other name, a group-blind delete looks exactly like a correct one.
    seat(tables, "g2", "phone", FRESH);
    seat(tables, "g2", "desk", FRESH);

    // The manifest at the new epoch is the roster (#307), so a removal and a departure both free
    // their slot through this one call and neither needs a mechanism of its own.
    await keepOnly(env, "g1", ["desk", "laptop"]);
    expect(idsIn(tables, "g1")).toEqual(["desk", "laptop"]);

    // And another group keeps every device it had, including the one this rotation dropped from
    // g1 — which is what stops one household's rotation freeing another's slots.
    expect(idsIn(tables, "g2")).toEqual(["desk", "phone"]);

    // A manifest may name a device that has never presented a token — it was sealed a key at
    // pairing and has not synced yet. That is not an instruction to seat it: this call deletes,
    // and `admitDevice` is the only thing that admits.
    await keepOnly(env, "g1", ["desk", "never-connected"]);
    expect(idsIn(tables, "g1")).toEqual(["desk"]);
  });
});

describe("forgetGroup", () => {
  it("empties one group and leaves another alone", async () => {
    const tables = fakeTables({ groups: ["g1", "g2"] });
    const env = fakeEnvOver(tables);
    seat(tables, "g1", "desk", FRESH);
    seat(tables, "g1", "phone", FRESH);
    seat(tables, "g2", "desk", FRESH);

    // A re-claim moves a subject's binding to a different group and drops the old group's log
    // and keys with it. Rows left behind would hold slots in a group whose count nothing will
    // ever take again — unreachable rather than merely orphaned.
    await forgetGroup(env, "g1");

    expect(idsIn(tables, "g1")).toEqual([]);
    expect(idsIn(tables, "g2")).toEqual(["desk"]);
  });
});
