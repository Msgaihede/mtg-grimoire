import { afterEach, describe, expect, it, vi } from "vitest";
import { harness, interaction, signedRequest, signer, untouchable } from "./fake";
import worker from "./index";
import { MAX_INTERACTION_BYTES, hexToBytes } from "./verify";

/**
 * Discord's signature, the one door `/interactions` has. **Discord probes for it**: when the
 * Interactions Endpoint URL is saved, and now and then after, it sends requests with bad
 * signatures and will not keep an endpoint that does not answer them 401. Every refusal here is
 * asserted over a database that throws if it is touched and a bot namespace that records — a
 * request that is not Discord's must reach neither.
 */

afterEach(() => vi.unstubAllGlobals());

const PING = { type: 1, id: "1", application_id: "100000000000000001", token: "t" };

/** A harness signed for by a key of the suite's, whose database throws. */
async function sealed() {
  const key = await signer();
  const h = harness({ publicKey: key.publicKeyHex });
  h.env.DB = untouchable;
  return { key, h };
}

describe("POST /interactions, signed", () => {
  it("answers Discord's ping with a pong, asking nobody", async () => {
    const { key, h } = await sealed();
    const answer = await worker.fetch(await interaction(key, PING), h.env);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("application/json");
    expect(await answer.json()).toEqual({ type: 1 });
    expect(h.bots.calls).toEqual([]);
  });

  it("reads the body as JSON only after the signature verified", async () => {
    const { key, h } = await sealed();
    const garbage = "{not json";
    expect((await worker.fetch(await signedRequest(key, garbage), h.env)).status).toBe(400);
    // The same garbage unsigned is a 401 — never the 400 that says it was parsed.
    const unsigned = await signedRequest(key, garbage, { signature: "00".repeat(64) });
    expect((await worker.fetch(unsigned, h.env)).status).toBe(401);
  });

  it("takes an upper-case key and signature as Discord may print them", async () => {
    const key = await signer();
    const h = harness({ publicKey: key.publicKeyHex.toUpperCase() });
    const text = JSON.stringify(PING);
    const signature = (await key.sign("1760700000", text)).toUpperCase();
    const answer = await worker.fetch(await signedRequest(key, text, { signature }), h.env);
    expect(answer.status).toBe(200);
  });
});

describe("POST /interactions, refused with 401", () => {
  it("without a signature", async () => {
    const { key, h } = await sealed();
    const answer = await worker.fetch(await interaction(key, PING, { signature: null }), h.env);
    expect(answer.status).toBe(401);
    expect(await answer.json()).toEqual({
      error: "invalid request signature",
      code: "bad_signature",
    });
  });

  it("without a timestamp", async () => {
    const { key, h } = await sealed();
    const text = JSON.stringify(PING);
    const bare = new Request("https://discord.mtg-grimoire.app/interactions", {
      method: "POST",
      headers: { "x-signature-ed25519": await key.sign("1760700000", text) },
      body: text,
    });
    expect((await worker.fetch(bare, h.env)).status).toBe(401);
  });

  it("signed by another key", async () => {
    const { h } = await sealed();
    const other = await signer();
    expect((await worker.fetch(await interaction(other, PING), h.env)).status).toBe(401);
  });

  it("signed over another timestamp", async () => {
    const { key, h } = await sealed();
    const text = JSON.stringify(PING);
    const signature = await key.sign("1760700000", text);
    const request = await signedRequest(key, text, { timestamp: "1760700001", signature });
    expect((await worker.fetch(request, h.env)).status).toBe(401);
  });

  it("with a body changed after it was signed", async () => {
    const { key, h } = await sealed();
    const signature = await key.sign("1760700000", JSON.stringify(PING));
    const request = await signedRequest(key, JSON.stringify({ ...PING, type: 2 }), { signature });
    expect((await worker.fetch(request, h.env)).status).toBe(401);
    expect(h.bots.calls).toEqual([]);
  });

  it("with a signature that is not hex, or not 64 bytes", async () => {
    const { key, h } = await sealed();
    for (const signature of ["zz".repeat(64), "00".repeat(63), "0".repeat(127), ""]) {
      const answer = await worker.fetch(await interaction(key, PING, { signature }), h.env);
      expect(answer.status, signature).toBe(401);
    }
  });

  it("with a body past the cap, whatever its signature", async () => {
    const { key, h } = await sealed();
    const big = { ...PING, padding: "x".repeat(MAX_INTERACTION_BYTES) };
    expect((await worker.fetch(await interaction(key, big), h.env)).status).toBe(401);
  });

  it("with a body that is not UTF-8, which could not be forwarded as it was signed", async () => {
    const { key, h } = await sealed();
    const body = new Uint8Array([0x7b, 0xff, 0x7d]);
    const request = new Request("https://discord.mtg-grimoire.app/interactions", {
      method: "POST",
      headers: {
        "x-signature-timestamp": "1760700000",
        "x-signature-ed25519": await key.signBytes("1760700000", body),
      },
      body,
    });
    expect((await worker.fetch(request, h.env)).status).toBe(401);
  });
});

describe("the application's public values", () => {
  it("answer 503 on every route while they are wrangler.jsonc's placeholders", async () => {
    const key = await signer();
    const h = harness({ placeholders: true });
    h.env.DB = untouchable;
    for (const [method, path] of [
      ["POST", "/interactions"],
      ["POST", "/link/begin"],
      ["POST", "/link/claim"],
      ["POST", "/link/enroll"],
      ["GET", "/link"],
      ["DELETE", "/link"],
      ["GET", "/oauth/discord/callback"],
    ]) {
      const request =
        path === "/interactions"
          ? await interaction(key, PING)
          : new Request(`https://discord.mtg-grimoire.app${path}`, { method });
      const answer = await worker.fetch(request, h.env);
      expect(answer.status, `${method} ${path}`).toBe(503);
      expect(await answer.json()).toMatchObject({ code: "not_configured" });
    }
    expect(h.bots.calls).toEqual([]);
    expect(h.limited).toEqual([]);
  });

  it("still answer an unknown path 404 and a wrong method 405 while unset", async () => {
    const h = harness({ placeholders: true });
    const missing = await worker.fetch(new Request("https://discord.mtg-grimoire.app/nope"), h.env);
    expect(missing.status).toBe(404);
    const wrong = await worker.fetch(
      new Request("https://discord.mtg-grimoire.app/interactions"),
      h.env,
    );
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toBe("POST");
  });
});

describe("hexToBytes", () => {
  it("reads hex and refuses anything else", () => {
    expect(hexToBytes("00ff10")).toEqual(new Uint8Array([0, 255, 16]));
    expect(hexToBytes("ABcd")).toEqual(new Uint8Array([171, 205]));
    expect(hexToBytes("abc")).toBeNull();
    expect(hexToBytes("zz")).toBeNull();
  });
});
