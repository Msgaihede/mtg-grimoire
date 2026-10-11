import { describe, expect, it } from "vitest";
import { MAX_RUN_BYTES } from "./env";
import {
  ADDRESS,
  KEY,
  TOKEN,
  frames,
  inbox,
  jpeg,
  label,
  scan,
  tokenFor,
  untouchable,
} from "./fake";
import worker from "./index";
import type { Sidecar } from "./submit";

/**
 * The door: a scan is taken from a supporter's device and from nobody else.
 *
 * Driven through `worker.fetch`, for `submit.test.ts`'s reason — what is fenced is *where* the
 * door stands. A stranger's request is refused before its type, its label or its body is read
 * and before the bucket is touched, so every refusal here is asserted over a bucket that throws.
 */

async function refusal(response: Response): Promise<{ error: string; code?: string }> {
  return (await response.json()) as { error: string; code?: string };
}

describe("a supporter's device", () => {
  it("is let in by the relay's token, and its scan is stored", async () => {
    const box = inbox();
    const response = await worker.fetch(scan(), box.env);
    expect(response.status).toBe(201);
    expect(box.objects.size).toBe(2);
  });

  it("is let in until the instant its token dies, and not at it", async () => {
    // `verify` is handed this Worker's clock. A token good for another minute is taken; one
    // whose instant has come is not — `<=`, the relay's own rule.
    const soon = await tokenFor(Date.now() + 60_000);
    expect((await worker.fetch(scan({ token: soon }), inbox().env)).status).toBe(201);
    const gone = await tokenFor(Date.now() - 1);
    expect((await worker.fetch(scan({ token: gone }), inbox().env)).status).toBe(401);
  });

  it("leaves nothing of its token in what is stored", async () => {
    // The token names a membership and a sync group: the one thing in a submission that could
    // say who sent it. It opens the door and is thrown away.
    const box = inbox();
    const response = await worker.fetch(scan(), box.env);
    const { id } = (await response.json()) as { id: string };
    const stored = new TextDecoder().decode(box.objects.get(`labels/${id}.json`)?.bytes);
    const sidecar = JSON.parse(stored) as Sidecar;
    expect(sidecar).toEqual({ ...label(), id, received_at: sidecar.received_at, bytes: frames().length });
    const everything = [...box.objects.values()]
      .map((object) => new TextDecoder().decode(object.bytes))
      .join("\n");
    for (const part of ["patreon-user-1", "a-sync-group-id", "a-device-id", TOKEN, TOKEN.split(".")[0]]) {
      expect(everything, part).not.toContain(part);
    }
    // And the limiter is still asked about the address, never about a group.
    expect(box.limited).toEqual([`submit:${ADDRESS}`]);
  });
});

describe("anybody else", () => {
  it("is refused with no token, before anything about the scan is read", async () => {
    const box = inbox();
    const request = scan({ token: null });
    const response = await worker.fetch(request, { ...box.env, SCANS: untouchable });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(await refusal(response)).toEqual({ error: "unauthorized", code: "unauthorized" });
    expect(request.bodyUsed).toBe(false);
  });

  it("is refused the same way whatever is wrong with what it sent", async () => {
    // One sentence for all of them, which says nothing of which: none, not a bearer, junk,
    // another key's, edited, half of one.
    const other = await tokenFor(Date.UTC(2100, 0, 1), "another-key");
    const [payload, signature] = TOKEN.split(".");
    const forged = `${btoa(JSON.stringify({ sub: "x", grp: "y", exp: Date.UTC(2100, 0, 1) }))}.${signature}`;
    const env = { ...inbox().env, SCANS: untouchable };
    const wrong: [string, Record<string, string> | { token: string | null }][] = [
      ["no header", { token: null }],
      ["a bare token", { authorization: TOKEN }],
      ["another scheme", { authorization: `Basic ${TOKEN}` }],
      ["a lower-case scheme", { authorization: `bearer ${TOKEN}` }],
      ["an empty bearer", { authorization: "Bearer " }],
      ["junk", { token: "nonsense" }],
      ["another key's", { token: other }],
      ["an edited payload", { token: forged }],
      ["a payload alone", { token: payload }],
      ["a signature alone", { token: `.${signature}` }],
    ];
    for (const [what, sent] of wrong) {
      const request =
        "token" in sent ? scan({ token: sent.token }) : scan({ token: null, headers: sent });
      const response = await worker.fetch(request, env);
      expect(response.status, what).toBe(401);
      expect(await refusal(response), what).toEqual({ error: "unauthorized", code: "unauthorized" });
    }
  });

  it("learns nothing else about the route: every other refusal is behind the door", async () => {
    // One picture's type, no label, a body past the cap, a full inbox: each has an answer of
    // its own for a supporter, and for anybody else each is the same 401.
    const full = inbox({ waiting: 500 });
    const requests = [
      scan({ token: null, type: "image/jpeg", body: jpeg(300) }),
      scan({ token: null, labelText: null }),
      scan({ token: null, headers: { "content-length": String(MAX_RUN_BYTES + 1) } }),
      scan({ token: null }),
    ];
    for (const request of requests) {
      const response = await worker.fetch(request, { ...full.env, SCANS: untouchable });
      expect(response.status).toBe(401);
    }
    expect(full.lists).toEqual([]);
  });

  it("is still counted by the limiter, which stands in front of the door", async () => {
    // A flood with no token is made to cost least by the limiter: it is asked first, and a
    // refused address is not even checked for a token.
    const open = inbox();
    await worker.fetch(scan({ token: null }), { ...open.env, SCANS: untouchable });
    expect(open.limited).toEqual([`submit:${ADDRESS}`]);

    const shut = inbox({ allow: false });
    const response = await worker.fetch(scan({ token: null }), { ...shut.env, SCANS: untouchable });
    expect(response.status).toBe(429);
  });
});

describe("a Worker that holds no key", () => {
  it("says so in a 500 that names it, to a supporter and a stranger alike", async () => {
    // A deploy made before the owner set the secret. Not a 401 — nobody's token is wrong — and
    // not an exception, which this Worker's missing log would make an error page saying nothing.
    for (const key of [null, ""]) {
      const box = inbox({ key });
      for (const request of [scan(), scan({ token: null })]) {
        const response = await worker.fetch(request, { ...box.env, SCANS: untouchable });
        expect(response.status).toBe(500);
        expect(await refusal(response)).toEqual({
          error: "this Worker holds no RELAY_HMAC_KEY",
          code: "no_key",
        });
      }
    }
  });

  it("takes nothing while it is in that state", async () => {
    const box = inbox({ key: null });
    await worker.fetch(scan(), box.env);
    expect(box.objects.size).toBe(0);
    expect(KEY).not.toBe("");
  });
});
