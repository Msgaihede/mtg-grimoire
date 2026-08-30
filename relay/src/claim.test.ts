import { describe, expect, it } from "vitest";
import {
  codeFrom,
  DEVICE_ID,
  GROUP_ID,
  handleClaim,
  handleToken,
  normaliseCode,
  RELAY_AUTH,
  settle,
  unixSeconds,
} from "./claim";
import { fakeEnv, fakeEnvOver, fakeTables, type Tables } from "./fakeD1";
import { recordRotation, seedGroup } from "./groupauth";
import { verify } from "./token";
import type { Env } from "./index";

/**
 * The decisions `claim.ts` makes that are functions of their arguments rather than of the
 * network — a status mapping, a unit conversion, a code alphabet, two body validators — plus the
 * whole of `/token`, which is I/O but is I/O against D1 alone and so runs on `fakeD1`'s
 * evaluating harness.
 *
 * Each of the pure four fails in a way that is invisible from the outside: a reader who syncs
 * for ever after cancelling, a sync that dies silently a day later, a code that is refused
 * because it was typed the way it was printed, and — new here — a group auth stored in a case
 * no device derives.
 */

const NOW = 1_756_000_000_000;

/** `sync_engine::entitlement::SECONDS_CEILING` — the app refuses any wire value above it. */
const SECONDS_CEILING = 100_000_000_000;

/**
 * Thirty-two bytes of lowercase hex, which is the only shape a `relay_auth` ever takes.
 *
 * **Both carry letters deliberately.** An all-digit auth like `"11".repeat(32)` is its own upper
 * case, so every assertion below about case would have passed against a pattern that did not
 * check it — which is how the first draft of this file went green on a bug.
 */
const AUTH_ONE = "ab12".repeat(16);
const AUTH_TWO = "cd34".repeat(16);

/**
 * A device id in the shape the app actually sends: `identity::ensure` mints sixteen random bytes
 * through the same `hex` the auths above use, so thirty-two lowercase characters.
 *
 * The short ids elsewhere in this file (`d1`, `desk`) are legal too — `DEVICE_ID` is a character
 * class rather than a length — and they are used where a test is about *which* row moved, because
 * five thirty-two-character strings in one assertion say nothing to a reader.
 */
const DEVICE = "9f".repeat(16);

/**
 * Not a real key, and it does not have to be. `mint` and `verify` are the same two lines of HMAC
 * whatever they are handed, and `token.test.ts` owns the question of whether they agree.
 */
const HMAC = "a-signing-key-for-tests";

describe("unixSeconds", () => {
  it("turns this file's milliseconds into the wire's seconds", () => {
    expect(unixSeconds(NOW)).toBe(1_756_000_000);
  });

  it("floors rather than rounds, so an expiry never reads as later than it is", () => {
    expect(unixSeconds(NOW + 999)).toBe(1_756_000_000);
  });

  it("lands below the magnitude guard the app refuses above", () => {
    // The failure this conversion exists to prevent: milliseconds crossing the wire make
    // `expires - now` about 1.8e12 in the app, forever larger than its six-hour refresh
    // margin, so the token is never refreshed and every *sync* request 401s a day later on a
    // route that cannot re-mint. `store_grant` refuses a value above the ceiling for exactly
    // this reason; this is the half that has to hand it a second in the first place.
    expect(unixSeconds(NOW)).toBeLessThan(SECONDS_CEILING);
    expect(NOW).toBeGreaterThan(SECONDS_CEILING);
  });
});

describe("settle", () => {
  it("serves an active membership", () => {
    expect(settle("active", null, NOW)).toBe("active");
  });

  it("serves a grace window that is still open", () => {
    expect(settle("grace", NOW + 1, NOW)).toBe("grace");
  });

  it("still serves at the exact instant the window ends", () => {
    // `>` and not `>=`, matching `decide`'s own comparison. The two functions are asked the
    // same question by different routes, and a reader's status must not depend on which one
    // the request happened to go through.
    expect(settle("grace", NOW, NOW)).toBe("grace");
  });

  it("kills a grace window one millisecond after it closed", () => {
    // **The decision no webhook ever announces.** A window opens on a declined card and closes
    // seven days later with nothing to fire, so every path that serves off a stored row has to
    // ask — or a declined reader syncs for ever.
    expect(settle("grace", NOW - 1, NOW)).toBe("dead");
  });

  it.each([[null], [0], [-1]])(
    "kills a grace row whose deadline is %j rather than an instant",
    (graceUntil) => {
      // A window with no closing time is worse than a closed one. `decide` never writes this
      // pair, but `schema.sql` permits a NULL and a caller spelling `graceUntil ?? 0` writes
      // the zero.
      expect(settle("grace", graceUntil, NOW)).toBe("dead");
    },
  );

  it.each([["dead"], ["something_written_by_a_later_build"], [""]])(
    "reads %j as dead",
    (status) => {
      expect(settle(status, NOW + 1, NOW)).toBe("dead");
    },
  );
});

describe("codeFrom", () => {
  it("draws twelve characters as three groups of four", () => {
    expect(codeFrom(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]))).toBe("0123-4567-89AB");
  });

  it("takes the low five bits, so every character is equally likely", () => {
    // A byte is 0-255 and 256 is exactly eight times 32, so masking is uniform where an index
    // taken from the whole byte would run off the end of the alphabet. These twelve bytes are
    // the twelve above plus 32, and must draw the same code.
    expect(codeFrom(new Uint8Array([32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43]))).toBe(
      "0123-4567-89AB",
    );
  });

  it("reaches the top of the alphabet", () => {
    expect(codeFrom(new Uint8Array(12).fill(255))).toBe("ZZZZ-ZZZZ-ZZZZ");
  });

  it("refuses to draw a code out of too few bytes", () => {
    // Without this, a short array indexes past its end, `undefined & 31` is `0`, and the tail
    // of the code is a run of zeros — a code that looks right and carries less entropy than it
    // claims.
    expect(() => codeFrom(new Uint8Array(11))).toThrow();
  });
});

describe("normaliseCode", () => {
  it("strips the separators a reader copies with the code", () => {
    expect(normaliseCode("0123-4567-89AB")).toBe("0123456789AB");
  });

  it("accepts lower case and stray spaces", () => {
    expect(normaliseCode(" 0123 4567 89ab ")).toBe("0123456789AB");
  });

  it("folds the three characters Crockford's alphabet leaves out", () => {
    // The whole reason this alphabet was chosen: these are the confusions a person makes
    // copying between two screens.
    expect(normaliseCode("oIlO")).toBe("0110");
  });

  it("drops a U rather than inventing a substitution for it", () => {
    // Crockford defines no folding for `U`, so a code containing one is a code that was
    // mistyped into a different length — and a length that does not match is a lookup that
    // finds nothing, which is the right answer arrived at honestly.
    expect(normaliseCode("U")).toBe("");
  });

  it("leaves every character a minted code can contain exactly as it is", () => {
    // **The invariant the mint side depends on.** `handleCallback` stores
    // `normaliseCode(codeFrom(...))` and `handleClaim` looks up `normaliseCode(pasted)`, so if
    // normalising ever moved a character of the alphabet the two would disagree and every
    // claim would be refused.
    for (const character of "0123456789ABCDEFGHJKMNPQRSTVWXYZ") {
      expect(normaliseCode(character)).toBe(character);
    }
  });

  it("round-trips a minted code to itself without its hyphens", () => {
    const minted = codeFrom(new Uint8Array([31, 30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20]));

    expect(minted).toBe("ZYXW-VTSR-QPNM");
    expect(normaliseCode(minted)).toBe("ZYXWVTSRQPNM");
  });
});

describe("GROUP_ID", () => {
  it("accepts the shape a minted group uid takes", () => {
    expect(GROUP_ID.test("Nx7-_aZ09")).toBe(true);
  });

  it.each([[""], ["has a space"], ["slash/es"], ["percent%41"], ["a".repeat(129)]])(
    "refuses %j",
    (id) => {
      // This is the pattern `ROUTE` carries, applied to the group id in a `/claim` body. A
      // binding the router could never carry mints tokens whose `grp` names a path segment
      // that 404s — a claim that succeeds and a sync that can never work.
      expect(GROUP_ID.test(id)).toBe(false);
    },
  );
});

describe("RELAY_AUTH", () => {
  it("accepts thirty-two bytes of lowercase hex", () => {
    expect(AUTH_ONE).toHaveLength(64);
    expect(RELAY_AUTH.test(AUTH_ONE)).toBe(true);
  });

  it("refuses the same value in upper case", () => {
    // Both sides emit lowercase and neither normalises, so an upper-case auth stored by
    // `/claim` is a credential no device in the group can ever derive — the group would be
    // locked out of its own key at the next `/token`.
    //
    // The first line is not ceremony: an all-digit fixture is its own upper case, and this
    // whole family of assertions passes against a pattern with no case check if it ever
    // becomes one again.
    expect(AUTH_ONE.toUpperCase()).not.toBe(AUTH_ONE);
    expect(RELAY_AUTH.test(AUTH_ONE.toUpperCase())).toBe(false);
  });

  it.each([[""], ["11"], ["1".repeat(63)], ["1".repeat(65)], [`${"1".repeat(63)}g`]])(
    "refuses %j",
    (auth) => {
      expect(RELAY_AUTH.test(auth)).toBe(false);
    },
  );
});

describe("DEVICE_ID", () => {
  it("accepts the shape identity::ensure mints", () => {
    expect(DEVICE).toHaveLength(32);
    expect(DEVICE_ID.test(DEVICE)).toBe(true);
  });

  it.each([[""], ["has a space"], ["slash/es"], ["percent%41"], ["a".repeat(129)]])(
    "refuses %j",
    (id) => {
      // This value reaches `group_devices.device_id`, and is then compared against a manifest's
      // key set by `keepOnly` and against `/keys`'s `?device=` by `rotate.ts`. `%41` and `A`
      // would be one device in the reader's head and two rows against the cap, with no later
      // point at which the disagreement becomes visible.
      expect(DEVICE_ID.test(id)).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------------------
// The two doors on /token
// ---------------------------------------------------------------------------------------

/**
 * `fakeEnv` supplies D1 and nothing else, because `groupauth.ts` needs nothing else. `/token`
 * mints, so it also needs the signing key — and it asks for it through `required`, which turns
 * an unset binding into a throw rather than into tokens signed with the word "undefined".
 */
function tokenEnv(...groups: string[]): Env {
  return { ...fakeEnv(...groups), RELAY_HMAC_KEY: HMAC };
}

/**
 * A `GROUP` namespace that records the internal path each `dropGroup` aims at it.
 *
 * **The path and not merely a count**, because `/g/{group}/drop` carries the group id — which is
 * the whole question a re-claim's teardown raises: the old group's log must go and the one just
 * bound must not. A spy that only counted calls would give the same answer either way.
 */
function fakeGroups(dropped: string[]): unknown {
  return {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: (url: string) => {
        dropped.push(new URL(url).pathname);
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    }),
  };
}

interface Harness {
  tables: Tables;
  env: Env;
  /** The `/g/{group}/drop` paths this run sent to the Durable Object, in order. */
  dropped: string[];
}

/**
 * `tokenEnv` with the tables and the Durable Object drops handed back, which is what every
 * assertion about `group_devices` and about a moved binding has to read.
 */
function harness(options: { groups: string[]; bound?: boolean }): Harness {
  const tables = fakeTables(options);
  const dropped: string[] = [];
  const env = {
    ...fakeEnvOver(tables),
    RELAY_HMAC_KEY: HMAC,
    GROUP: fakeGroups(dropped),
  } as unknown as Env;
  return { tables, env, dropped };
}

/**
 * Seat a device in a group, seen a second ago.
 *
 * **The real clock rather than this file's `NOW`**, because the handlers pass `Date.now()` to
 * `admitDevice` and `NOW` is over a year in the past — a row stamped with it is outside the
 * ninety-day window and would be pruned before it could be counted, so every cap fixture would
 * quietly seat nothing.
 */
function seat(tables: Tables, group: string, device: string): void {
  const seen = Date.now() - 1000;
  tables.group_devices.push({
    group_id: group,
    device_id: device,
    first_seen: seen,
    last_seen: seen,
  });
}

/** Which devices a group is holding, as the table actually has them. */
function idsIn(tables: Tables, group: string): string[] {
  return tables.group_devices
    .filter((row) => row.group_id === group)
    .map((row) => String(row.device_id))
    .sort();
}

/** Which groups `group_keys` is holding a row for. */
function keyedGroups(tables: Tables): string[] {
  return tables.group_keys.map((row) => String(row.group_id)).sort();
}

function post(path: string, body: unknown): Request {
  return new Request(`https://relay.example${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * Deliberately a type that admits `refresh` even where the design forbids it. A body typed as
 * the four-field answer would make `expect(body.refresh)` a compile error, and the assertion
 * that has to be able to fail is exactly the one saying that field is absent.
 */
interface Overshared {
  access?: string;
  refresh?: string;
  expires?: number;
  status?: string;
  since?: number;
  error?: string;
  /** The machine-readable half of a refusal. Only the device cap sets one. */
  code?: string;
}

/** The `{status, body}` pair every assertion below is written against. */
async function answer(response: Response): Promise<{ status: number; body: Overshared }> {
  return { status: response.status, body: (await response.json()) as Overshared };
}

describe("/token — the refresh door", () => {
  it("answers all five fields, the refresh secret among them", async () => {
    const env = tokenEnv("g1");

    const request = post("/token", { refresh: "secret-0", device: DEVICE });
    const { status, body } = await answer(await handleToken(request, env));

    expect(status).toBe(200);
    // The whole shape at once. `sync_engine::entitlement::Grant` deserialises this, and a
    // missing or renamed field is a runtime serde failure with every test on both sides green.
    expect(Object.keys(body).sort()).toEqual(["access", "expires", "refresh", "since", "status"]);
    expect(body.refresh).toBe("secret-0");
    expect(body.status).toBe("active");
    expect(body.since).toBe(0);
  });

  it("refuses a secret no row holds", async () => {
    const env = tokenEnv("g1");

    const request = post("/token", { refresh: "not-a-secret", device: DEVICE });
    const { status } = await answer(await handleToken(request, env));

    expect(status).toBe(401);
  });

  it.each([
    [{ device: DEVICE }],
    [{ refresh: "", device: DEVICE }],
    [{ refresh: 5, device: DEVICE }],
    [{ refresh: null, device: DEVICE }],
  ])("refuses %j as malformed rather than looking it up", async (body) => {
    // **Each of these carries a valid `device`**, so the 400 can only be about the field the
    // case is named for. Without it every row here would pass against a handler that refused
    // every body outright, which is what the cases below are for.
    const { status } = await answer(await handleToken(post("/token", body), tokenEnv("g1")));

    expect(status).toBe(400);
  });

  it.each([
    [{ refresh: "secret-0" }],
    [{ refresh: "secret-0", device: "" }],
    [{ refresh: "secret-0", device: "slash/es" }],
    [{ refresh: "secret-0", device: 7 }],
    [{ refresh: "secret-0", device: "a".repeat(129) }],
  ])("refuses %j, so the cap cannot be stepped round by omission", async (body) => {
    // ⚠️ **The missing-`device` row is the one that matters.** This repository is public and a
    // reader builds it; a `device` the relay merely *used if present* would be a cap any caller
    // could opt out of by leaving one field off a body — and the point of a device limit is
    // precisely the case where somebody has a reason to exceed it.
    //
    // `noDatabase` is what makes this a claim about the guard rather than about the answer: the
    // secret is a real one, so a handler that looked it up before checking `device` would reach
    // D1 and throw rather than answering 400.
    const { status } = await answer(await handleToken(post("/token", body), noDatabase()));

    expect(status).toBe(400);
  });

  it("refuses a body that is not JSON at all", async () => {
    const request = new Request("https://relay.example/token", { method: "POST", body: "{" });

    const { status } = await answer(await handleToken(request, tokenEnv("g1")));

    expect(status).toBe(400);
  });
});

describe("/token — the group door", () => {
  it("answers four fields and never the refresh secret", async () => {
    const env = tokenEnv("g1");
    await seedGroup(env, "g1", 0, AUTH_ONE);

    const request = post("/token", { group: "g1", auth: AUTH_ONE, device: DEVICE });
    const { status, body } = await answer(await handleToken(request, env));

    expect(status).toBe(200);
    // **The assertion the whole door exists to satisfy.** A device that proved it is in the
    // group has proved nothing about the Patreon account; the refresh secret can revoke, rebind
    // and re-register, so handing it over would make every paired device able to evict every
    // other one.
    expect(Object.keys(body).sort()).toEqual(["access", "expires", "since", "status"]);
    expect(body.refresh).toBeUndefined();
    expect(body.status).toBe("active");
    expect(body.since).toBe(0);
  });

  it("mints a token naming the group asked for and the subject that owns it", async () => {
    const env = tokenEnv("g1", "g2");
    await seedGroup(env, "g1", 0, AUTH_ONE);
    await seedGroup(env, "g2", 3, AUTH_TWO);

    const request = post("/token", { group: "g2", auth: AUTH_TWO, device: DEVICE });
    const { body } = await answer(await handleToken(request, env));
    const claims = await verify(String(body.access), HMAC, Date.now());

    // `grp` is what `index.ts` compares against the `/g/{group}/…` path segment before the
    // Durable Object hop, so a token minted for the wrong group is a mint that succeeds and a
    // sync that 401s for ever. `sub-1` is `g2`'s row, not `g1`'s.
    expect(claims?.grp).toBe("g2");
    expect(claims?.sub).toBe("sub-1");
    // The milliseconds-to-seconds boundary, asserted where it actually crosses.
    expect(body.expires).toBe(unixSeconds(Number(claims?.exp)));
  });

  it("refuses an auth the group is not standing on", async () => {
    const env = tokenEnv("g1");
    await seedGroup(env, "g1", 0, AUTH_ONE);

    const request = post("/token", { group: "g1", auth: AUTH_TWO, device: DEVICE });
    const { status, body } = await answer(await handleToken(request, env));

    expect(status).toBe(401);
    expect(body.access).toBeUndefined();
  });

  it("refuses the auth the group was standing on before a rotation", async () => {
    // **The removal, seen from this door, and the reason it is `authIsCurrent` rather than
    // `authIsRecent`.** A device that was removed still knows the epoch-0 auth and cannot
    // compute the epoch-1 one, so this refusal is the whole of what stops it minting a token
    // and carrying on syncing. `/keys` deliberately takes the stale auth — a device that is
    // merely behind has to be told apart from one that is out, and the manifest is what tells
    // them apart — so the two questions must not be answered by the same helper.
    const env = tokenEnv("g1");
    await seedGroup(env, "g1", 0, AUTH_ONE);
    expect(await recordRotation(env, "g1", 1, AUTH_TWO, { desk: "blob" })).toBe(true);

    const current = post("/token", { group: "g1", auth: AUTH_TWO, device: DEVICE });
    const stale = post("/token", { group: "g1", auth: AUTH_ONE, device: DEVICE });

    expect((await answer(await handleToken(current, env))).status).toBe(200);
    expect((await answer(await handleToken(stale, env))).status).toBe(401);
  });

  it("refuses one group's auth presented against another group", async () => {
    const env = tokenEnv("g1", "g2");
    await seedGroup(env, "g1", 0, AUTH_ONE);
    await seedGroup(env, "g2", 0, AUTH_TWO);

    const request = post("/token", { group: "g1", auth: AUTH_TWO, device: DEVICE });
    const { status } = await answer(await handleToken(request, env));

    // Both auths are current — each for its own group. A door that looked an auth up without
    // the group would answer this one with a token for `g1`.
    expect(status).toBe(401);
  });

  it("refuses a group the relay holds keys for but no membership", async () => {
    // `g2` is seeded into `group_keys` and has no entitlement row, which is spec §2.4's "no
    // membership, no removal" seen from `/token`: the auth is one this relay has stored, and it
    // still opens nothing.
    const env = tokenEnv("g1");
    await seedGroup(env, "g2", 0, AUTH_TWO);

    const request = post("/token", { group: "g2", auth: AUTH_TWO, device: DEVICE });
    const { status } = await answer(await handleToken(request, env));

    expect(status).toBe(401);
  });

  it("refuses a group whose entitlement has never registered an auth", async () => {
    // Every entitlement written before this change is in exactly this state: bound to a group,
    // `group_auth` still NULL. A NULL that compared equal to anything would hand a token to any
    // caller who guessed the group id, which is the whole of what the gate is protecting.
    const env = tokenEnv("g1");

    const request = post("/token", { group: "g1", auth: AUTH_ONE, device: DEVICE });
    const { status } = await answer(await handleToken(request, env));

    expect(status).toBe(401);
  });

  it("refuses a dead entitlement even on a current auth", async () => {
    const env = tokenEnv("g1");
    await seedGroup(env, "g1", 0, AUTH_ONE);
    await env.DB.prepare(`UPDATE entitlements SET status = ? WHERE subject = ?`)
      .bind("dead", "sub-0")
      .run();

    const request = post("/token", { group: "g1", auth: AUTH_ONE, device: DEVICE });
    const { status } = await answer(await handleToken(request, env));

    expect(status).toBe(401);
  });

  it.each([
    [{ group: "g1", device: DEVICE }],
    [{ auth: AUTH_ONE, device: DEVICE }],
    [{ group: "g1", auth: "not hex", device: DEVICE }],
    [{ group: "g1", auth: AUTH_ONE.toUpperCase(), device: DEVICE }],
    [{ group: "slash/es", auth: AUTH_ONE, device: DEVICE }],
    [{ group: 7, auth: AUTH_ONE, device: DEVICE }],
    // The device's own four shapes, on a body whose group and auth are both good — so the 400
    // is about the device and not about something else the row happens to be missing.
    [{ group: "g1", auth: AUTH_ONE }],
    [{ group: "g1", auth: AUTH_ONE, device: "" }],
    [{ group: "g1", auth: AUTH_ONE, device: "slash/es" }],
    [{ group: "g1", auth: AUTH_ONE, device: 7 }],
  ])("refuses %j as malformed rather than looking it up", async (body) => {
    const env = tokenEnv("g1");
    await seedGroup(env, "g1", 0, AUTH_ONE);

    const { status } = await answer(await handleToken(post("/token", body), env));

    expect(status).toBe(400);
  });

  it("answers a body carrying both shapes on the refresh door", async () => {
    // The app sends one shape or the other and never both (spec §2.5), so this pins a choice
    // rather than a requirement — but the choice has to turn on *presence*, not on validity.
    // Branching on whether `refresh` parses would let a caller who names a secret be answered
    // about a credential they did not present, by spoiling the one they did.
    const env = tokenEnv("g1");
    await seedGroup(env, "g1", 0, AUTH_ONE);

    const both = post("/token", {
      refresh: "secret-0",
      group: "g1",
      auth: AUTH_ONE,
      device: DEVICE,
    });
    const spoiled = post("/token", {
      refresh: "",
      group: "g1",
      auth: AUTH_ONE,
      device: DEVICE,
    });

    expect((await answer(await handleToken(both, env))).body.refresh).toBe("secret-0");
    expect((await answer(await handleToken(spoiled, env))).status).toBe(400);
  });
});

describe("/token — a grace window settles the same on both doors", () => {
  /**
   * Two subjects, one per door, so neither call can disturb the other's row. `sub-0` is reached
   * by its refresh secret and `sub-1` by `g2`'s group auth.
   *
   * These assert the refusal rather than the revocation that goes with it, which is a choice
   * about scope and no longer a limitation: this doc used to say `fakeD1` bound a `WHERE` by
   * counting `SET` *assignments*, so `revoke`'s three literals shifted its parameters and the
   * statement silently matched nothing. The harness counts the `?` in the `SET` list now, and
   * the revocation is asserted where it belongs — in the cap suite below, on the one path where
   * the ordering of a refusal against a write is the whole point.
   */
  async function twoDoors(graceUntil: number): Promise<Env> {
    const env = tokenEnv("g1", "g2");
    await seedGroup(env, "g2", 0, AUTH_TWO);
    for (const subject of ["sub-0", "sub-1"]) {
      await env.DB.prepare(`UPDATE entitlements SET status = ?, grace_until = ? WHERE subject = ?`)
        .bind("grace", graceUntil, subject)
        .run();
    }
    return env;
  }

  it("serves both doors while the window is open", async () => {
    const env = await twoDoors(Date.now() + 60_000);

    const refreshDoor = post("/token", { refresh: "secret-0", device: DEVICE });
    const groupDoor = post("/token", { group: "g2", auth: AUTH_TWO, device: DEVICE });
    const viaRefresh = await answer(await handleToken(refreshDoor, env));
    const viaGroup = await answer(await handleToken(groupDoor, env));

    expect(viaRefresh.status).toBe(200);
    expect(viaRefresh.body.status).toBe("grace");
    // The status has to reach the app on this door too: it is what draws the panel's warning,
    // and a device that only ever mints through its group would otherwise never be told.
    expect(viaGroup.status).toBe(200);
    expect(viaGroup.body.status).toBe("grace");
  });

  it("refuses both doors once the window has closed", async () => {
    const env = await twoDoors(Date.now() - 1);

    const refreshDoor = post("/token", { refresh: "secret-0", device: DEVICE });
    const groupDoor = post("/token", { group: "g2", auth: AUTH_TWO, device: DEVICE });
    const viaRefresh = await answer(await handleToken(refreshDoor, env));
    const viaGroup = await answer(await handleToken(groupDoor, env));

    // A window closes with nothing to announce it, so a door that merely read the stored
    // `grace` and served would keep a declined reader's every paired device syncing for ever.
    expect(viaRefresh.status).toBe(401);
    expect(viaGroup.status).toBe(401);
    expect(viaGroup.body.access).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------
// The five-device cap, at the two doors that mint
// ---------------------------------------------------------------------------------------

/**
 * Spec §4.2 seen from the route rather than from `groupauth.ts`: the counting itself is
 * `admitDevice`'s and is tested there, so what is left here is the three things only a handler
 * can get wrong — whether the door registers at all, whether it registers *before* deciding the
 * membership is worth serving, and which status it refuses with.
 */
describe("/token — the five-device cap", () => {
  it("registers the connecting device, which only ever uses the refresh door", async () => {
    // Spec §4.2, and the reason `device` is on this shape at all. The device that pressed
    // Connect holds the refresh secret and never derives a group auth, so a cap that counted
    // only the group door would leave the one device certainly signed in permanently uncounted.
    const { tables, env } = harness({ groups: ["g1"] });

    const request = post("/token", { refresh: "secret-0", device: DEVICE });
    expect((await answer(await handleToken(request, env))).status).toBe(200);

    expect(idsIn(tables, "g1")).toEqual([DEVICE]);
  });

  it("registers a device that inherited its sign-in through the group door", async () => {
    const { tables, env } = harness({ groups: ["g1"] });
    await seedGroup(env, "g1", 0, AUTH_ONE);

    const request = post("/token", { group: "g1", auth: AUTH_ONE, device: DEVICE });
    expect((await answer(await handleToken(request, env))).status).toBe(200);

    // The reader's own words: *"this goes for accounts inheriting the sign-in from another
    // grouped device too"*.
    expect(idsIn(tables, "g1")).toEqual([DEVICE]);
  });

  it.each([
    ["the refresh door", { refresh: "secret-0", device: "d6" }],
    ["the group door", { group: "g1", auth: AUTH_ONE, device: "d6" }],
  ])("refuses a sixth device on %s with 403 and a sentence naming the limit", async (_, body) => {
    const { tables, env } = harness({ groups: ["g1"] });
    await seedGroup(env, "g1", 0, AUTH_ONE);
    for (const device of ["d1", "d2", "d3", "d4", "d5"]) seat(tables, "g1", device);

    const answered = await answer(await handleToken(post("/token", body), env));

    // ⚠️ **403 and never 401.** `sync_engine::entitlement`'s 401 path clears the grant, so a cap
    // routed through one would tell a reader who had just set up a laptop that their membership
    // had ended — and would then offer them the connect button for a membership they still hold.
    expect(answered.status).toBe(403);
    // The sentence has to name the number: a reader looking at a roster needs to know how many
    // rows they are allowed to keep. Matched rather than compared against the module's own
    // constant, which would be the policy agreeing with itself.
    expect(answered.body.error).toMatch(/5 devices/);
    // ⚠️ **The code is the contract and the sentence is copy.** `/claim` answered 403 to *that
    // membership no longer exists* and *that membership is not active* long before a device
    // limit existed, so an app branching on the status alone tells a lapsed reader they have
    // five devices. `sync_engine::entitlement::DEVICE_LIMIT` is the other half of this literal
    // and nothing across the two languages checks the pair — which is why both sides pin it.
    expect(answered.body.code).toBe("device_limit");
    expect(answered.body.access).toBeUndefined();
    // And the refused device leaves no row. One that moved a `last_seen` on its way to being
    // turned away would be admitted by the very next request.
    expect(idsIn(tables, "g1")).toEqual(["d1", "d2", "d3", "d4", "d5"]);
  });

  it.each([
    ["the refresh door", { refresh: "secret-0", device: "d3" }],
    ["the group door", { group: "g1", auth: AUTH_ONE, device: "d3" }],
  ])("re-admits a device the full group already holds, on %s", async (_, body) => {
    const { tables, env } = harness({ groups: ["g1"] });
    await seedGroup(env, "g1", 0, AUTH_ONE);
    for (const device of ["d1", "d2", "d3", "d4", "d5"]) seat(tables, "g1", device);

    // The settled five-device household. Every sync any of them does comes back through one of
    // these two doors, so a cap that counted a returning device as a new one would refuse all
    // five of them from the day the fifth was admitted.
    expect((await answer(await handleToken(post("/token", body), env))).status).toBe(200);

    expect(idsIn(tables, "g1")).toEqual(["d1", "d2", "d3", "d4", "d5"]);
  });

  it("spends no slot on a membership it is about to refuse", async () => {
    // ⚠️ **The ordering the cap turns on, and the reason `admitDevice` is called last on both
    // doors.** A dead membership that took a slot on its way to a 401 would spend a reader's
    // devices on requests that were refused anyway — four such and every real device is locked
    // out of an account nobody is even serving.
    const { tables, env } = harness({ groups: ["g1"] });
    await seedGroup(env, "g1", 0, AUTH_ONE);
    for (const device of ["d1", "d2", "d3", "d4"]) seat(tables, "g1", device);
    await env.DB.prepare(`UPDATE entitlements SET status = ? WHERE subject = ?`)
      .bind("dead", "sub-0")
      .run();

    const viaRefresh = post("/token", { refresh: "secret-0", device: "newcomer" });
    const viaGroup = post("/token", { group: "g1", auth: AUTH_ONE, device: "newcomer" });

    expect((await answer(await handleToken(viaRefresh, env))).status).toBe(401);
    expect((await answer(await handleToken(viaGroup, env))).status).toBe(401);
    expect(idsIn(tables, "g1")).toEqual(["d1", "d2", "d3", "d4"]);

    // And §7.1's revocation did run, which is what makes the assertion above about the *cap*
    // rather than about a refusal that happened before anything at all was attempted.
    expect(tables.entitlements[0].refresh_secret).toBeNull();
  });

  it("spends no slot on a group auth it is about to refuse", async () => {
    // The other half: a stale auth is refused before the row is even loaded, so a rotated-away
    // device cannot burn its old group's slots by re-presenting the auth it remembers.
    const { tables, env } = harness({ groups: ["g1"] });
    await seedGroup(env, "g1", 0, AUTH_ONE);

    const request = post("/token", { group: "g1", auth: AUTH_TWO, device: "removed" });
    expect((await answer(await handleToken(request, env))).status).toBe(401);

    expect(idsIn(tables, "g1")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------
// /claim's two new body fields
// ---------------------------------------------------------------------------------------

/**
 * An `Env` whose D1 makes any query a failure, so a 400 against it is proof the guard ran
 * *first* rather than merely proof of a 400.
 */
function noDatabase(): Env {
  return {
    DB: {
      prepare: () => {
        throw new Error("a body reached D1 before it had been validated");
      },
    },
    RELAY_HMAC_KEY: HMAC,
  } as unknown as Env;
}

/**
 * The whole `/claim` body, and the only place in this file it is spelled out.
 *
 * `sync_engine::entitlement::claim` serialises exactly these five names. A field renamed on one
 * side is a body serde refuses at runtime with every test on both sides green, so the shape is
 * written once here and spread everywhere else.
 */
const WELL_FORMED = {
  code: "0123-4567-89AB",
  group: "g1",
  epoch: 0,
  auth: AUTH_ONE,
  device: DEVICE,
};

/** A live code for `WELL_FORMED`, against `sub-0`. `normaliseCode` strips the separators. */
function withCode(tables: Tables): Tables {
  tables.claim_codes = [
    { code: "0123456789AB", subject: "sub-0", expires_at: Date.now() + 60_000 },
  ];
  return tables;
}

/**
 * `epoch` and `auth` are checked before `handleClaim` touches D1 at all, which is what these
 * assert.
 *
 * **The seeding itself is asserted below, since 2026-08-30.** It could not be while `fakeD1`
 * answered `DELETE … RETURNING subject` with no rows rather than by throwing — every claim
 * stopped at the 401 — and while the binding `UPDATE`'s
 * `WHERE … AND (group_id IS NULL OR group_id = ?)` threw `expected select, found group_id`,
 * because a `(` in a condition was read as the start of a subquery. The harness grew `RETURNING`,
 * `OR`, parenthesised groups and `IS NULL`, so both statements now run.
 */
describe("/claim — the group key's two body fields", () => {
  it("carries a well-formed body past every guard and into the code lookup", async () => {
    // **The control that stops the refusals below being vacuous.** Without it they would all
    // still pass against a handler that answered 400 to everything. 401 is the honest answer to
    // a code no `claim_codes` row holds, and it is reached only after `code`, `group`, `epoch`
    // and `auth` have each been accepted.
    const request = post("/claim", WELL_FORMED);
    const { status, body } = await answer(await handleClaim(request, fakeEnv()));

    expect(status).toBe(401);
    expect(body.error).toBe("that claim code is not valid");
  });

  it.each([
    [{ ...WELL_FORMED, epoch: undefined }],
    [{ ...WELL_FORMED, epoch: "0" }],
    [{ ...WELL_FORMED, epoch: 1.5 }],
    [{ ...WELL_FORMED, epoch: -1 }],
    [{ ...WELL_FORMED, auth: undefined }],
    [{ ...WELL_FORMED, auth: "" }],
    [{ ...WELL_FORMED, auth: AUTH_ONE.toUpperCase() }],
    [{ ...WELL_FORMED, auth: `${"1".repeat(63)}g` }],
    // `device` is checked with the same care and ahead of the code lookup, because that lookup
    // *spends* the code: a body refused after the `DELETE … RETURNING` costs the reader another
    // trip through Patreon's consent page for a field the relay never needed D1 to read.
    [{ ...WELL_FORMED, device: undefined }],
    [{ ...WELL_FORMED, device: "" }],
    [{ ...WELL_FORMED, device: "slash/es" }],
    [{ ...WELL_FORMED, device: 7 }],
    [{ ...WELL_FORMED, device: "a".repeat(129) }],
  ])("refuses %j without touching D1", async (body) => {
    const { status } = await answer(await handleClaim(post("/claim", body), noDatabase()));

    expect(status).toBe(400);
  });

  it("refuses an epoch too large for the monotonic check to advance", async () => {
    // `Number.isInteger(1e300)` is true and `1e300 + 1 === 1e300`, so a group claimed at that
    // epoch could never accept a rotation again and no removal in it would ever publish. The
    // guard is `isSafeInteger` for this one value's sake.
    const unsafe = post("/claim", { ...WELL_FORMED, epoch: 1e300 });
    const largest = post("/claim", { ...WELL_FORMED, epoch: Number.MAX_SAFE_INTEGER });

    expect((await answer(await handleClaim(unsafe, noDatabase()))).status).toBe(400);
    // The largest epoch integer arithmetic is still exact at is accepted, so the guard refuses
    // unsafe values rather than merely large ones.
    expect((await answer(await handleClaim(largest, fakeEnv()))).status).toBe(401);
  });
});

/**
 * The write a claim makes that nothing else can make, and the ordering that keeps it honest.
 *
 * **A claim is the only moment the relay is ever told a group exists.** `/rotate` authenticates
 * against an auth only `seedGroup` can have written, so a claim that bound a group and registered
 * nothing would leave a group whose auth no device can match and whose every rotation is refused
 * — with the reader's Connect press having reported success. That is the failure this pair pins.
 *
 * **The second test is the one that survived a mutation before the harness could run these.**
 * Moving `seedGroup` above the binding `UPDATE` leaves the first test green: the group is bound,
 * the key is registered, everything looks right. Only a claim that is *refused* tells the two
 * orders apart, which is why the 409 is here rather than filed with the other refusals.
 */
describe("/claim — registering the group's relay key", () => {
  it("binds the group, registers its first relay key and seats the claiming device", async () => {
    // `bound: false` is the state a first claim finds: no group, no refresh secret. It is what
    // makes the binding UPDATE take the `group_id IS NULL` arm rather than the re-claim arm.
    const { tables, env } = harness({ groups: ["g1"], bound: false });
    withCode(tables);

    const { status } = await answer(await handleClaim(post("/claim", WELL_FORMED), env));

    expect(status).toBe(200);
    expect(tables.entitlements[0].group_id).toBe("g1");
    // The manifest starts empty — a group of one has nobody to rewrap for — but the ROW has to
    // exist, because `recordRotation` refuses an epoch that does not advance one.
    expect(tables.group_keys).toHaveLength(1);
    expect(tables.group_keys[0]).toMatchObject({ group_id: "g1", epoch: 0, auth: AUTH_ONE });
    expect(JSON.parse(String(tables.group_keys[0].keys))).toEqual({});
    // And the code is spent, which is the `DELETE … RETURNING` doing its other job.
    expect(tables.claim_codes).toHaveLength(0);
    // **The claim issues a token, so it takes a slot like any other token.** A claim that
    // registered nothing would leave the paying device uncounted until its next `/token` a day
    // later — and a sixth device could take the last slot from it in the meantime.
    expect(idsIn(tables, "g1")).toEqual([DEVICE]);
  });

  it("registers nothing when the binding is refused", async () => {
    // `sub-0` is unbound and holds the code; `sub-1` already owns `g1`. The binding UPDATE
    // changes no row, `handleClaim` answers 409, and `group_keys` must still hold only the row
    // `sub-1` put there — never a second one under `sub-0`'s auth.
    const { tables, env } = harness({ groups: ["taken", "g1"], bound: true });
    withCode(tables);
    tables.entitlements[0].group_id = null;
    tables.entitlements[0].refresh_secret = null;
    await seedGroup(env, "g1", 4, AUTH_TWO);

    const { status } = await answer(await handleClaim(post("/claim", WELL_FORMED), env));

    expect(status).toBe(409);
    expect(tables.group_keys).toHaveLength(1);
    expect(tables.group_keys[0]).toMatchObject({ epoch: 4, auth: AUTH_TWO });
    // And no slot was taken in a group this claim did not bind: an unbound row would hold one of
    // `sub-1`'s five devices against a count `sub-1` cannot see, and a caller who knew a group id
    // could spend all five that way.
    expect(idsIn(tables, "g1")).toEqual([]);
  });

  it("refuses a sixth device with 403, and leaves the group able to free a slot", async () => {
    // The wiped reinstall: the data folder went, so `identity::ensure` minted a fresh id and no
    // manifest names the old row. Everything else about this reader is fine.
    const { tables, env } = harness({ groups: ["g1"], bound: true });
    withCode(tables);
    for (const device of ["d1", "d2", "d3", "d4", "d5"]) seat(tables, "g1", device);

    const { status, body } = await answer(await handleClaim(post("/claim", WELL_FORMED), env));

    // 403 rather than 401, for both doors' reason: this reader is paying, and the app clears a
    // grant on a 401.
    expect(status).toBe(403);
    expect(body.error).toMatch(/5 devices/);
    expect(body.access).toBeUndefined();
    expect(idsIn(tables, "g1")).toEqual(["d1", "d2", "d3", "d4", "d5"]);
    // ⚠️ **And the group can still rotate**, which is the reader's way out — remove a device,
    // the rotation frees its row, claim again. `seedGroup` runs ahead of the cap for this: a
    // refusal placed before it would leave a group bound with `group_auth` still NULL, `/rotate`
    // would refuse every removal, and every retry would refuse in the same place for ever.
    // `fakeTables` files every entitlement with a NULL `group_auth`, so this is the claim's own
    // write and not the fixture's.
    expect(tables.entitlements[0].group_auth).toBe(AUTH_ONE);
    expect(tables.group_keys).toHaveLength(1);
  });
});

/**
 * Spec §3, which **reverses** the refusal the previous spec argued for.
 *
 * **The dead end it exists to remove.** #307 gave a device the ability to leave its group. The
 * paying device leaves; its entitlement is still bound to the group it left; it founds a group of
 * one or pairs elsewhere, presses Connect, and the old `handleClaim` answered *409 — that
 * membership is already bound to another sync group*. There was no press that helped and no way
 * back that was not a hand edit of D1.
 *
 * **What the 409 was protecting is kept.** Trust-on-first-use stopped one subscription serving
 * two groups at once, and moving a binding leaves the subject serving exactly one. Only the first
 * stops being the latest — and the 409 itself survives for the case it is really about, which is
 * another *subject* on one group id.
 */
describe("/claim — the binding moves rather than being refused", () => {
  /** A `group_keys` row, so a test can say a group already had a manifest before this claim. */
  function keyed(tables: Tables, group: string, epoch: number): void {
    tables.group_keys.push({
      group_id: group,
      epoch,
      auth: AUTH_TWO,
      keys: JSON.stringify({ desk: "blob" }),
      created_at: 0,
    });
  }

  it("moves a bound subject onto a new group and takes the old one apart", async () => {
    // `sub-0` is bound to `old` and holds the code; `sub-1` is a second household on `far`.
    const { tables, env, dropped } = harness({ groups: ["old", "far"] });
    withCode(tables);
    keyed(tables, "old", 2);
    keyed(tables, "far", 9);
    seat(tables, "old", "desk");
    seat(tables, "old", "phone");
    // ⚠️ **`far` holds a device called `phone` on purpose.** That is the id this teardown deletes
    // from `old`, so a `DELETE … WHERE device_id = ?` that had lost its `group_id` would take
    // this row with it. Seated under any other name, a group-blind delete looks exactly like a
    // correct one and the cross-group assertion below could not fail.
    seat(tables, "far", "phone");

    const { status } = await answer(await handleClaim(post("/claim", WELL_FORMED), env));

    expect(status).toBe(200);
    expect(tables.entitlements[0].group_id).toBe("g1");
    // The old group's key history is retired and the new group's is seeded. `far`'s is neither.
    expect(keyedGroups(tables)).toEqual(["far", "g1"]);
    // Its device roll goes with it — rows in a group nothing is bound to are counted by a count
    // nobody will ever take again, which is unreachable rather than merely orphaned.
    expect(idsIn(tables, "old")).toEqual([]);
    expect(idsIn(tables, "far")).toEqual(["phone"]);
    expect(idsIn(tables, "g1")).toEqual([DEVICE]);
    // And the log itself. The path names the group, so this cannot pass against a drop aimed at
    // the group the claim just bound.
    expect(dropped).toEqual(["/g/old/drop"]);
  });

  it("still refuses another subject on one group id, and takes nothing apart", async () => {
    // `sub-0` is bound to `old` and holds the code; `sub-1` already owns `g1`. This is a shared
    // subscription wearing two names — the thing `entitlements_group` is actually about, and the
    // one case the 409 still exists for. It is reached by *catching* the unique violation rather
    // than by asking a question first: D1 has no interactive transaction.
    const { tables, env, dropped } = harness({ groups: ["old", "g1"] });
    withCode(tables);
    keyed(tables, "old", 2);
    seat(tables, "old", "desk");

    const { status, body } = await answer(await handleClaim(post("/claim", WELL_FORMED), env));

    expect(status).toBe(409);
    expect(body.error).toBe("that sync group is bound to another membership");
    // ⚠️ **And the claimant's own group is untouched** — which is why the teardown runs *after*
    // the binding UPDATE and not before it. Ordered the other way, this press would destroy a
    // working group's keys, devices and log on its way to refusing the press that asked for it,
    // and pairing into somebody else's group by mistake would cost a reader their own.
    expect(tables.entitlements[0].group_id).toBe("old");
    expect(keyedGroups(tables)).toEqual(["old"]);
    expect(idsIn(tables, "old")).toEqual(["desk"]);
    expect(dropped).toEqual([]);
  });

  it("takes nothing apart when the group claimed is the one already bound", async () => {
    // A reader who sold the laptop holding the refresh secret connects Patreon again and
    // re-claims the group they are still in. `seedGroup` is `INSERT OR IGNORE` for this: writing
    // over the row would replace a live manifest with an empty one, which is every remaining
    // device reading itself as removed.
    const { tables, env, dropped } = harness({ groups: ["g1"] });
    withCode(tables);
    // At the epoch `WELL_FORMED` claims, which is the state a re-claim from a device that is
    // *caught up* finds — and the only one in which `INSERT OR IGNORE` has a conflict to ignore,
    // since `group_keys` is keyed on `(group_id, epoch)`.
    keyed(tables, "g1", 0);
    seat(tables, "g1", "desk");

    const { status } = await answer(await handleClaim(post("/claim", WELL_FORMED), env));

    expect(status).toBe(200);
    expect(tables.group_keys).toHaveLength(1);
    // The live manifest survives, blob and all: this row was not deleted by a teardown and was
    // not written over by the claim's own empty one.
    expect(JSON.parse(String(tables.group_keys[0].keys))).toEqual({ desk: "blob" });
    // `9f…` sorts ahead of `desk`: the device that just claimed is seated beside the one that
    // was already there rather than replacing the roll.
    expect(idsIn(tables, "g1")).toEqual([DEVICE, "desk"]);
    expect(dropped).toEqual([]);
  });
});
