import { describe, expect, it } from "vitest";
import { mint, TOKEN_TTL_MS, verify, type Claims } from "./token";

const SECRET = "a-relay-hmac-key-for-tests-only";
const NOW = 1_756_000_000_000;
const claims = (over: Partial<Claims> = {}): Claims => ({
  sub: "sub_abc",
  grp: "0123456789abcdef0123456789abcdef",
  exp: NOW + TOKEN_TTL_MS,
  ...over,
});

describe("token", () => {
  it("round-trips the claims it was minted with", async () => {
    const token = await mint(claims(), SECRET);

    expect(await verify(token, SECRET, NOW)).toEqual(claims());
  });

  it("refuses a token signed with a different secret", async () => {
    // This is what rotating RELAY_HMAC_KEY does to every outstanding token, and the break-glass
    // depends on it being a refusal rather than a silent acceptance.
    const token = await mint(claims(), SECRET);

    expect(await verify(token, "some-other-key", NOW)).toBeNull();
  });

  it("refuses a token whose payload was edited", async () => {
    // The attack this exists to stop: take your own valid token and change `grp` to somebody
    // else's group id.
    const token = await mint(claims(), SECRET);
    const [payload, signature] = token.split(".");
    const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as Claims;
    decoded.grp = "ffffffffffffffffffffffffffffffff";
    const forged = btoa(JSON.stringify(decoded)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    expect(await verify(`${forged}.${signature}`, SECRET, NOW)).toBeNull();
  });

  it("refuses a signature of the wrong length, and one that differs only at its last character", async () => {
    // The forgery test above cannot see a *weak* comparison, only a missing one: a forged
    // payload's signature differs from the original in essentially every position, so even a
    // verifier that checked one character would refuse it. Catching a weakening takes a genuine
    // signature, minimally altered — and it takes two different alterations, because there are
    // two separate things in the comparison to pin.
    //
    // The first two assertions are the wrong *length*: the real signature cut to 8 characters,
    // and the real signature with four appended. Base64url of a 32-byte HMAC is exactly 43
    // characters, so both are refused by the length guard — before the comparison loop runs a
    // single iteration. They pin that guard and nothing else, which is why they are not enough
    // on their own.
    //
    // The third reaches past it. Same 43 characters, differing only at index 42, so the loop has
    // to run to the end to see it. Without this line, capping that loop at eight iterations
    // passes every other assertion in this file while comparing 48 of the signature's 256 bits.
    const token = await mint(claims(), SECRET);
    const [payload, signature] = token.split(".");
    // Any character but the one already there; the ternary only exists so the flip cannot be a
    // no-op whatever the last character happens to be.
    const lastCharChanged = signature.slice(0, -1) + (signature.endsWith("A") ? "B" : "A");

    expect(signature).toHaveLength(43);
    expect(lastCharChanged).toHaveLength(signature.length);
    expect(await verify(`${payload}.${signature.slice(0, 8)}`, SECRET, NOW)).toBeNull();
    expect(await verify(`${payload}.${signature}AAAA`, SECRET, NOW)).toBeNull();
    expect(await verify(`${payload}.${lastCharChanged}`, SECRET, NOW)).toBeNull();
  });

  it("refuses a valid token with a third part appended", async () => {
    // `"a.b.c"` in the malformed list below does not actually pin the part count: its two
    // leading parts are not a genuine payload/signature pair, so it is refused by the
    // signature check whatever the count check does. This is the case that needs the count —
    // relaxing it to `parts.length < 2` makes `{payload}.{signature}.anything` verify, because
    // destructuring takes the first two and they are real. Two spellings of one token that both
    // authenticate is a malleability nobody downstream would think to guard against.
    const token = await mint(claims(), SECRET);

    expect(await verify(`${token}.`, SECRET, NOW)).toBeNull();
    expect(await verify(`${token}.junk`, SECRET, NOW)).toBeNull();
  });

  it("refuses a token that has expired", async () => {
    const token = await mint(claims({ exp: NOW - 1 }), SECRET);

    expect(await verify(token, SECRET, NOW)).toBeNull();
    // The instant `exp` names is the first instant the token is no longer good for, so the
    // boundary belongs on this side of it. Without this line, `exp < nowMs` in place of
    // `exp <= nowMs` passes every other assertion in the file — the two tests either side of
    // this one sit a millisecond away and cannot see the instant itself.
    expect(await verify(await mint(claims({ exp: NOW }), SECRET), SECRET, NOW)).toBeNull();
  });

  it("accepts a token one millisecond before it expires", async () => {
    // The boundary is worth pinning: an off-by-one here logs every reader out a day early or
    // a day late, and neither is visible in a passing suite that only tests the middle.
    const token = await mint(claims({ exp: NOW + 1 }), SECRET);

    expect(await verify(token, SECRET, NOW)).not.toBeNull();
  });

  it.each(["", "not-a-token", "a.b.c", "onlyonepart", ".", "a."])(
    "refuses the malformed token %j rather than throwing",
    async (bad) => {
      // The gate calls this on attacker-controlled input. A throw here is a 500 where a 401
      // belongs, and a 500 is a Durable Object request that should never have been billed.
      expect(await verify(bad, SECRET, NOW)).toBeNull();
    },
  );

  it("is twenty-four hours", () => {
    // Pinned to a literal, and not to `TOKEN_TTL_MS` itself, because every other assertion in
    // this file derives its expiry from the constant and so moves with it. Shrinking the window
    // to zero is caught by the round-trip; growing it from a day to a month was caught by nothing
    // at all until this line. Growth is the direction that matters: this constant is the ceiling
    // on how long a cancelled membership keeps working after the relay has stopped honouring it,
    // so widening it silently is the failure nobody would see.
    expect(TOKEN_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
});
