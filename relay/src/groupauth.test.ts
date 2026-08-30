import { describe, expect, it } from "vitest";
import { fakeEnv } from "./fakeD1";
import {
  authIsCurrent,
  authIsRecent,
  currentManifest,
  equalsConstantTime,
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
