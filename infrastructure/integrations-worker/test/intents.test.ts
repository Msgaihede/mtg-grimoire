import { describe, expect, it } from "vitest";
import { decodeClaims, signToken, verifyToken, type Claims } from "../src/consumer";
import {
  parseAck,
  parseConsumerRequest,
  parseIntentShape,
  validatePayload,
  SCOPES,
} from "../src/intents";
import { consumerKey, newDataKey } from "../src/seal";
import { collectionAdd, wishlistAdd } from "./fake";

/**
 * The inbox's parsers and the consumer token, with no store: what plan §3.1 lets in, key for key,
 * and what it refuses. **A refusal here is noise kept out of an inbox, never the fence against a
 * write** — the device holds every intent to its own allow-list whatever this said
 * (`grimoire_core::integration::intents`) — so these cases are about the shape, and the device's
 * suite is about the write.
 */

/** `object` with `keys` left out. */
function without<T extends object>(object: T, ...keys: string[]): Partial<T> {
  return Object.fromEntries(
    Object.entries(object).filter(([key]) => !keys.includes(key)),
  ) as Partial<T>;
}

describe("a collection.add's payload", () => {
  const ok = collectionAdd().payload;

  it("is taken with its hints, and without them", () => {
    expect(validatePayload("collection.add", ok)).toEqual(ok);
    const bare = without(ok, "name", "set", "cn");
    expect(validatePayload("collection.add", bare)).toEqual(bare);
  });

  it.each([
    ["one key too many", { ...ok, purchasePrice: 3 }],
    ["a missing folder", { ...ok, folderUid: undefined }],
    ["the root as its folder", { ...ok, folderUid: null }],
    ["a quantity of 0", { ...ok, quantity: 0 }],
    ["a quantity of 100", { ...ok, quantity: 100 }],
    ["a fractional quantity", { ...ok, quantity: 1.5 }],
    ["a quantity as text", { ...ok, quantity: "2" }],
    ["an unknown finish", { ...ok, finish: "galaxy" }],
    ["no finish", { ...ok, finish: null }],
    ["an empty card id", { ...ok, scryfallId: "" }],
    ["a card id past 64", { ...ok, scryfallId: "x".repeat(65) }],
    ["a hint past 200", { ...ok, name: "x".repeat(201) }],
    ["a hint that is no string", { ...ok, set: 7 }],
    ["an array", [ok]],
    ["null", null],
  ])("refuses %s", (_label, payload) => {
    const clean =
      Array.isArray(payload) || payload === null ? payload : JSON.parse(JSON.stringify(payload));
    expect(typeof validatePayload("collection.add", clean)).toBe("string");
  });
});

describe("a wishlist.add's payload", () => {
  const ok = wishlistAdd().payload;

  it("is an any-printing wish at the root, or a printing in a folder", () => {
    expect(validatePayload("wishlist.add", ok)).toEqual(ok);
    const printing = {
      ...ok,
      scryfallId: "0000579f-7b35-4ed3-b44c-db2a538066fe",
      oracleId: null,
      finish: "foil",
      folderUid: "wf-1",
      set: "2x2",
      cn: "117",
    };
    expect(validatePayload("wishlist.add", printing)).toEqual(printing);
  });

  it.each([
    ["neither id", { ...ok, oracleId: null }],
    ["no name", { ...ok, name: null }],
    ["a missing key", without(ok, "folderUid")],
    ["a deck's uid as a key", { ...ok, deckUid: "d-1" }],
    ["a quantity of 100", { ...ok, quantity: 100 }],
    ["an unknown finish", { ...ok, finish: "galaxy" }],
  ])("refuses %s", (_label, payload) => {
    expect(typeof validatePayload("wishlist.add", payload)).toBe("string");
  });
});

describe("an intent's shape", () => {
  it("is { kind, payload, confirmedBy } with a known kind", () => {
    expect(parseIntentShape(collectionAdd())).toMatchObject({ kind: "collection.add" });
    expect(parseIntentShape({ ...collectionAdd(), confirmedBy: null })).toMatchObject({
      confirmedBy: null,
    });
  });

  it.each([
    ["an unknown kind", { ...collectionAdd(), kind: "collection.remove" }],
    ["a change", { ...collectionAdd(), kind: "collection.update" }],
    ["an id the consumer chose", { ...collectionAdd(), id: "AAAAAAAAAAAAAAAAAAAAAA" }],
    ["a state the consumer chose", { ...collectionAdd(), state: "applied" }],
    ["no confirmedBy", without(collectionAdd(), "confirmedBy")],
    ["a confirmedBy past 128", { ...collectionAdd(), confirmedBy: "x".repeat(129) }],
    ["a list", [collectionAdd()]],
    ["nothing", undefined],
  ])("refuses %s", (_label, body) => {
    expect(typeof parseIntentShape(body)).toBe("string");
  });
});

describe("an ack", () => {
  const lease = "A".repeat(22);

  it("applied carries its lease and a watermark, and no reason", () => {
    expect(parseAck({ state: "applied", reason: null, lease, hlcMs: 5, hlcCtr: 0 })).toEqual({
      state: "applied",
      reason: null,
      lease,
      hlcMs: 5,
      hlcCtr: 0,
    });
  });

  it("refused carries a reason, and may come with no lease or watermark", () => {
    expect(
      parseAck({
        state: "refused",
        reason: "That folder no longer exists.",
        lease: null,
        hlcMs: null,
        hlcCtr: null,
      }),
    ).toMatchObject({ state: "refused", lease: null });
  });

  it.each([
    ["applied with no lease", { state: "applied", reason: null, lease: null, hlcMs: 1, hlcCtr: 0 }],
    [
      "applied with no watermark",
      { state: "applied", reason: null, lease, hlcMs: null, hlcCtr: 0 },
    ],
    ["applied with a reason", { state: "applied", reason: "x", lease, hlcMs: 1, hlcCtr: 0 }],
    [
      "refused with no reason",
      { state: "refused", reason: null, lease: null, hlcMs: null, hlcCtr: null },
    ],
    [
      "refused past 300",
      { state: "refused", reason: "x".repeat(301), lease: null, hlcMs: null, hlcCtr: null },
    ],
    ["pending", { state: "pending", reason: null, lease: null, hlcMs: null, hlcCtr: null }],
    [
      "a lease of another shape",
      { state: "applied", reason: null, lease: "short", hlcMs: 1, hlcCtr: 0 },
    ],
    ["a negative clock", { state: "applied", reason: null, lease, hlcMs: -1, hlcCtr: 0 }],
    ["a missing key", { state: "applied", reason: null, lease, hlcMs: 1 }],
    ["an extra key", { state: "applied", reason: null, lease, hlcMs: 1, hlcCtr: 0, row: "u" }],
  ])("refuses %s", (_label, body) => {
    expect(parseAck(body)).toBeNull();
  });
});

describe("a mint's body", () => {
  it("is known scopes, put in canonical order, and 1 to 365 days", () => {
    expect(
      parseConsumerRequest({ scopes: ["wishlist:add", "collection:read"], days: 365 }),
    ).toEqual({
      scopes: ["collection:read", "wishlist:add"],
      days: 365,
    });
  });

  it.each([
    ["no scopes", { scopes: [], days: 1 }],
    ["an unknown scope", { scopes: ["collection:remove"], days: 1 }],
    ["a repeated scope", { scopes: ["decks:read", "decks:read"], days: 1 }],
    ["0 days", { scopes: ["decks:read"], days: 0 }],
    ["366 days", { scopes: ["decks:read"], days: 366 }],
    ["a fraction of a day", { scopes: ["decks:read"], days: 1.5 }],
    ["an extra key", { scopes: ["decks:read"], days: 1, group: "g2" }],
  ])("refuses %s", (_label, body) => {
    expect(parseConsumerRequest(body)).toBeNull();
  });
});

describe("a consumer token", () => {
  const claims: Claims = {
    grp: "g1",
    int: "discord",
    scp: [...SCOPES],
    exp: 2_000_000_000,
    tid: "B".repeat(22),
  };

  it("is gct1.<claims>.<mac>, verified under the key it was signed with and no other", async () => {
    const key = await consumerKey(newDataKey());
    const token = await signToken(key, claims);
    expect(token.split(".")[0]).toBe("gct1");
    expect(await verifyToken(key, token)).toEqual(claims);
    expect(await verifyToken(await consumerKey(newDataKey()), token)).toBeNull();
  });

  it("reads its claims unverified for routing, and nothing that is not one", async () => {
    const token = await signToken(await consumerKey(newDataKey()), claims);
    expect(decodeClaims(token)).toEqual(claims);
    const [prefix, body, mac] = token.split(".");
    for (const bad of [
      "",
      "gct1",
      `gct2.${body}.${mac}`,
      `${prefix}.${body}`,
      `${prefix}.!!!.${mac}`,
      `${prefix}.${body}.${mac}.x`,
      "x".repeat(2000),
    ]) {
      expect(decodeClaims(bad), bad.slice(0, 20)).toBeNull();
    }
  });

  it("will not carry claims it does not know, or a group outside the path alphabet", async () => {
    const key = await consumerKey(newDataKey());
    for (const bad of [
      { ...claims, grp: "a/b" },
      { ...claims, int: "trade" },
      { ...claims, scp: ["collection:remove"] },
      { ...claims, tid: "short" },
      { ...claims, extra: 1 },
    ]) {
      expect(decodeClaims(await signToken(key, bad as Claims))).toBeNull();
    }
  });

  it("refuses a MAC with one byte changed", async () => {
    const key = await consumerKey(newDataKey());
    const token = await signToken(key, claims);
    // A character well inside the MAC: the last one of 43 carries two bits base64url discards.
    const at = token.length - 10;
    const flipped = token.slice(0, at) + (token[at] === "A" ? "B" : "A") + token.slice(at + 1);
    expect(await verifyToken(key, flipped)).toBeNull();
  });
});
