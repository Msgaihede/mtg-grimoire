import { describe, expect, it } from "vitest";
import { codeFrom, GROUP_ID, normaliseCode, settle, unixSeconds } from "./claim";

/**
 * The four decisions `claim.ts` makes that are functions of their arguments rather than of D1,
 * the network or the clock. Everything else in that file is I/O and routing, which `log.ts`'s
 * split deliberately leaves to a deploy — but a status mapping, a unit conversion and a code
 * alphabet are not, and each of the three fails in a way that is invisible from the outside:
 * a reader who syncs for ever after cancelling, a sync that dies silently a day later, and a
 * code that is refused because it was typed the way it was printed.
 */

const NOW = 1_756_000_000_000;

/** `sync_engine::entitlement::SECONDS_CEILING` — the app refuses any wire value above it. */
const SECONDS_CEILING = 100_000_000_000;

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
