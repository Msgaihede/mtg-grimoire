import { describe, expect, it } from "vitest";
import { readIdentity, readMember, redirectUri, required, verifyWebhook } from "./patreon";

/**
 * The pure half of `patreon.ts`. The three `fetch` wrappers are deliberately not here — they
 * are I/O, and `log.ts`'s split leaves that to a deploy. What *is* here is every decision those
 * wrappers make once the bytes have arrived, because each one is a fact about a document
 * somebody else's server produced and each fails silently when it is wrong.
 */

/** RFC 2202 case 2, the one HMAC-MD5 vector whose key and message are both printable text. */
const WEBHOOK_BODY = "what do ya want for nothing?";
const WEBHOOK_SECRET = "Jefe";
const WEBHOOK_SIGNATURE = "750c783e6ab0b503eaa86e310a5db738";

function identityPayload(campaignId: string, patronStatus: unknown): unknown {
  return {
    data: { id: "user-1", type: "user" },
    included: [
      {
        type: "member",
        attributes: { patron_status: patronStatus },
        relationships: { campaign: { data: { id: campaignId, type: "campaign" } } },
      },
    ],
  };
}

describe("readIdentity", () => {
  it("reads the patron status of a membership to this campaign", () => {
    expect(readIdentity(identityPayload("camp-1", "active_patron"), "camp-1")).toEqual({
      userId: "user-1",
      patronStatus: "active_patron",
    });
  });

  it("reads a membership to another creator as no membership at all", () => {
    // The whole reason the campaign filter exists. Without it a reader who supports five other
    // people on Patreon reads as a supporter of this one, and the gate opens for anybody with
    // a Patreon account and one pledge anywhere.
    expect(readIdentity(identityPayload("someone-else", "active_patron"), "camp-1")).toEqual({
      userId: "user-1",
      patronStatus: null,
    });
  });

  it("picks this campaign's membership out of several", () => {
    const payload = {
      data: { id: "user-1", type: "user" },
      included: [
        {
          type: "member",
          attributes: { patron_status: "former_patron" },
          relationships: { campaign: { data: { id: "someone-else" } } },
        },
        {
          type: "member",
          attributes: { patron_status: "active_patron" },
          relationships: { campaign: { data: { id: "camp-1" } } },
        },
      ],
    };

    expect(readIdentity(payload, "camp-1")?.patronStatus).toBe("active_patron");
  });

  it("ignores the campaign resources the include path also brings back", () => {
    // `include=memberships.campaign` puts campaign objects in `included` beside the member
    // objects, and a campaign's own id is the id being matched against — so a match that did
    // not check `type` would find the campaign, read no `patron_status`, and answer null for
    // a reader who is in fact supporting.
    const payload = {
      data: { id: "user-1", type: "user" },
      included: [
        { type: "campaign", id: "camp-1", attributes: {} },
        {
          type: "member",
          attributes: { patron_status: "active_patron" },
          relationships: { campaign: { data: { id: "camp-1" } } },
        },
      ],
    };

    expect(readIdentity(payload, "camp-1")?.patronStatus).toBe("active_patron");
  });

  it("answers no patron status when the member carries none", () => {
    // `patron_status` is a sparse-fieldset request and Patreon may omit it. Null is what
    // `decide` reads as dead, which is the fail-closed direction.
    expect(readIdentity(identityPayload("camp-1", undefined), "camp-1")).toEqual({
      userId: "user-1",
      patronStatus: null,
    });
  });

  it("answers no membership when the document carries no memberships", () => {
    expect(readIdentity({ data: { id: "user-1" } }, "camp-1")).toEqual({
      userId: "user-1",
      patronStatus: null,
    });
  });

  it.each([[{}], [{ data: {} }], [{ data: { id: "" } }], [null], [undefined], ["not a document"]])(
    "answers null rather than a user for %j",
    (payload) => {
      // **`null` here must never be collapsed into "not a patron".** A document with no user in
      // it is the absence of an answer; treating it as a cancellation is how one shape change
      // on Patreon's side becomes a mass revocation.
      expect(readIdentity(payload, "camp-1")).toBeNull();
    },
  );
});

describe("readMember", () => {
  it("takes the user id from the relationship rather than the root", () => {
    // A webhook's primary `data` is the member, so the user is one hop away — the one
    // structural difference from the identity document.
    const payload = {
      data: {
        type: "member",
        attributes: { patron_status: "former_patron" },
        relationships: { user: { data: { id: "user-1", type: "user" } } },
      },
    };

    expect(readMember(payload)).toEqual({ userId: "user-1", patronStatus: "former_patron" });
  });

  it("answers no status when the body carries none", () => {
    const payload = { data: { relationships: { user: { data: { id: "user-1" } } } } };

    expect(readMember(payload)).toEqual({ userId: "user-1", patronStatus: null });
  });

  it.each([[{}], [{ data: {} }], [{ data: { relationships: {} } }], [null]])(
    "answers null rather than a user for %j",
    (payload) => {
      expect(readMember(payload)).toBeNull();
    },
  );
});

describe("verifyWebhook", () => {
  it("accepts a body signed with the shared secret", () => {
    expect(verifyWebhook(WEBHOOK_BODY, WEBHOOK_SIGNATURE, WEBHOOK_SECRET)).toBe(true);
  });

  it("accepts an uppercase digest, because hex is case-insensitive", () => {
    expect(verifyWebhook(WEBHOOK_BODY, WEBHOOK_SIGNATURE.toUpperCase(), WEBHOOK_SECRET)).toBe(true);
  });

  it("refuses a body that was edited after it was signed", () => {
    expect(verifyWebhook(`${WEBHOOK_BODY} `, WEBHOOK_SIGNATURE, WEBHOOK_SECRET)).toBe(false);
  });

  it("refuses a signature made with another secret", () => {
    expect(verifyWebhook(WEBHOOK_BODY, WEBHOOK_SIGNATURE, "jefe")).toBe(false);
  });

  it.each([[null], [""]])("refuses %j before comparing anything", (signature) => {
    // **The guard this test exists for is one line and its absence is invisible.**
    // `timingSafeEqualHex("", "")` is `true` and is pinned as such, so the tempting
    // `timingSafeEqualHex(header ?? "", expected ?? "")` authenticates an *unsigned* webhook.
    // This is the one path in the design where failing open destroys data: an unverified
    // `members:pledge:delete` deletes a reader's relay log.
    expect(verifyWebhook(WEBHOOK_BODY, signature, WEBHOOK_SECRET)).toBe(false);
  });
});

/**
 * The relay has two addresses since 2026-10-11 and Patreon holds a redirect URI for each. Which
 * one a reader's app named is not in the callback's query — it is the address the callback
 * arrived at — and the exchange fails with `invalid_grant` on the other.
 */
describe("redirectUri", () => {
  const env = {
    RELAY_BASE: "https://relay.example",
    RELAY_BASE_LEGACY: "https://old-relay.example",
  } as never;
  const at = (url: string) => new Request(url);

  it("repeats the current address for a callback that arrived there", () => {
    expect(redirectUri(env, at("https://relay.example/oauth/patreon/callback?code=x"))).toBe(
      "https://relay.example/oauth/patreon/callback",
    );
  });

  it("repeats the legacy address for a callback that arrived there", () => {
    // Every build through 0.44.0. Answering it with the current address is the failure this
    // function exists to prevent: Connect Patreon stops working for every installed app on the
    // day the relay's own address moves.
    expect(redirectUri(env, at("https://old-relay.example/oauth/patreon/callback?code=x"))).toBe(
      "https://old-relay.example/oauth/patreon/callback",
    );
  });

  it.each([
    ["https://evil.example/oauth/patreon/callback"],
    // An origin is a scheme, a host and a port: each of these is the legacy host and not the
    // legacy address.
    ["http://old-relay.example/oauth/patreon/callback"],
    ["https://old-relay.example:8443/oauth/patreon/callback"],
    ["https://old-relay.example.evil.example/oauth/patreon/callback"],
  ])("never sends Patreon an address that is not one of the two: %s", (url) => {
    expect(redirectUri(env, at(url))).toBe("https://relay.example/oauth/patreon/callback");
  });

  it.each([["RELAY_BASE"], ["RELAY_BASE_LEGACY"]])("names %s when it is unset", (name) => {
    const unset = { RELAY_BASE: "https://relay.example", RELAY_BASE_LEGACY: "https://old.example" };
    delete (unset as Record<string, string>)[name];
    expect(() => redirectUri(unset as never, at("https://relay.example/"))).toThrow(name);
  });
});

describe("required", () => {
  it("answers a binding that is set", () => {
    expect(required("a-value", "SOMETHING")).toBe("a-value");
  });

  it.each([[undefined], [""]])("throws and names the binding for %j", (value) => {
    // An unset binding does not fail the same way everywhere, which is why this is a helper
    // rather than a habit. `crypto.subtle` refuses a zero-length HMAC key outright; `hmacMd5`
    // does not — it pads whatever it is given and returns a valid digest, so an unset webhook
    // secret would verify against a key anybody can compute.
    expect(() => required(value, "PATREON_WEBHOOK_SECRET")).toThrow("PATREON_WEBHOOK_SECRET");
  });
});
