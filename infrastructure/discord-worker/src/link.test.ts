import { afterEach, describe, expect, it, vi } from "vitest";
import { LINK_REQUEST_TTL_MS, base64url, sha256, sha256Hex } from "./env";
import {
  DO_ID,
  READER,
  SECRET,
  desktop,
  harness,
  internet,
  jsonOf,
  linked,
  untouchable,
  type Harness,
} from "./fake";
import worker from "./index";
import { MAX_INVITE_CHARS } from "./link";
import { PAGE_POLICY, escapeHtml } from "./page";

/**
 * Linking a Discord account (the design, §13.3): begin, Discord's redirect, claim — and the routes
 * the link secret opens: enroll, status and unlink. The desktop never sees a Discord token and
 * this Worker never keeps one, and the tests below assert both absences against what was stored.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const VERIFIER = "a-verifier-the-desktop-made-of-forty-three-or-more-characters";
const INVITE = "an-invite-exactly-as-pairing-offer-code-spells-it";

const challengeOf = async (verifier: string) => base64url(await sha256(verifier));

function setup(options: Parameters<typeof harness>[0] = {}) {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  return harness(options);
}

async function begin(
  h: Harness,
  verifier = VERIFIER,
): Promise<{ code: string; authorizeUrl: string; expiresAt: number }> {
  const answer = await worker.fetch(
    desktop("POST", "/link/begin", jsonOf({ challenge: await challengeOf(verifier) })),
    h.env,
  );
  expect(answer.status).toBe(200);
  return (await answer.json()) as { code: string; authorizeUrl: string; expiresAt: number };
}

const callback = (query: string) =>
  new Request(`https://discord.mtg-grimoire.app/oauth/discord/callback?${query}`);

const claim = (h: Harness, code: string, verifier = VERIFIER) =>
  worker.fetch(desktop("POST", "/link/claim", jsonOf({ code, verifier })), h.env);

/** Begin, Discord's redirect, claim: a whole link, answered as the desktop is. */
async function linkThrough(h: Harness) {
  const { code } = await begin(h);
  await worker.fetch(callback(`code=good-code&state=${code}`), h.env);
  const answer = await claim(h, code);
  expect(answer.status).toBe(200);
  return (await answer.json()) as { secret: string; discordUserId: string; username: string };
}

describe("POST /link/begin", () => {
  it("stores a ten-minute request and answers Discord's authorize URL for a user install", async () => {
    const h = setup();
    const { code, authorizeUrl, expiresAt } = await begin(h);
    expect(code).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(expiresAt).toBe(NOW + LINK_REQUEST_TTL_MS);
    const url = new URL(authorizeUrl);
    expect(`${url.origin}${url.pathname}`).toBe("https://discord.com/oauth2/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "100000000000000001",
      response_type: "code",
      redirect_uri: "https://discord.mtg-grimoire.app/oauth/discord/callback",
      scope: "identify applications.commands",
      state: code,
      integration_type: "1",
      prompt: "consent",
    });
    // The scopes' space as `%20`, which every OAuth server reads, never `+`.
    expect(authorizeUrl).toContain("scope=identify%20applications.commands");
    expect(h.rows("discord_link_requests")).toEqual([
      {
        code,
        challenge: await challengeOf(VERIFIER),
        state: "pending",
        discord_user_id: null,
        username: null,
        created_at: NOW,
        expires_at: NOW + LINK_REQUEST_TTL_MS,
      },
    ]);
  });

  it("refuses a challenge that is not a SHA-256 in base64url", async () => {
    const h = setup();
    for (const challenge of [undefined, "", "short", "x".repeat(44), "+".repeat(43)]) {
      const answer = await worker.fetch(
        desktop("POST", "/link/begin", jsonOf({ challenge })),
        h.env,
      );
      expect(answer.status, String(challenge)).toBe(400);
    }
    expect(h.rows("discord_link_requests")).toEqual([]);
  });

  it("is limited per address, ahead of everything", async () => {
    const h = setup({ allow: false });
    h.env.DB = untouchable;
    const answer = await worker.fetch(
      desktop("POST", "/link/begin", jsonOf({ challenge: await challengeOf(VERIFIER) })),
      h.env,
    );
    expect(answer.status).toBe(429);
    expect(answer.headers.get("retry-after")).toBe("60");
    expect(await answer.json()).toMatchObject({ code: "rate_limited" });
    expect(h.limited).toEqual(["begin:203.0.113.9"]);
  });

  it("answers 503 while the client secret is not set", async () => {
    const h = setup({ secret: null });
    const answer = await worker.fetch(
      desktop("POST", "/link/begin", jsonOf({ challenge: await challengeOf(VERIFIER) })),
      h.env,
    );
    expect(answer.status).toBe(503);
    expect(await answer.json()).toMatchObject({ code: "not_configured" });
  });

  it("sweeps the requests past their ten minutes as it begins another", async () => {
    const h = setup();
    const stale = await begin(h);
    vi.setSystemTime(NOW + LINK_REQUEST_TTL_MS);
    const fresh = await begin(h);
    expect(h.rows("discord_link_requests").map((row) => row.code)).toEqual([fresh.code]);
    expect(stale.code).not.toBe(fresh.code);
  });
});

describe("the sign-in", () => {
  it("links: pending until Discord redirects, then the secret, once", async () => {
    const h = setup();
    const asked = internet({ user: { id: READER, username: "markus" } });
    const { code } = await begin(h);

    const waiting = await claim(h, code);
    expect(waiting.status).toBe(202);
    expect(await waiting.json()).toEqual({ status: "pending" });

    const page = await worker.fetch(callback(`code=good-code&state=${code}`), h.env);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("content-security-policy")).toBe(PAGE_POLICY);
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await page.text();
    expect(html).toContain("Linked as markus");
    expect(html).toContain("Return to MTG Grimoire");
    // Self-contained: nothing it could fetch, so nothing that could carry its address away.
    expect(html).not.toMatch(/<(script|img|link|iframe)\b|https?:\/\//i);

    // The code was exchanged with the client secret, and the name asked with the token.
    const [token, me] = asked;
    expect(token.url.href).toBe("https://discord.com/api/v10/oauth2/token");
    expect(token.method).toBe("POST");
    expect(Object.fromEntries(new URLSearchParams(token.body))).toEqual({
      grant_type: "authorization_code",
      code: "good-code",
      redirect_uri: "https://discord.mtg-grimoire.app/oauth/discord/callback",
    });
    expect(token.headers.get("authorization")).toBe(
      `Basic ${btoa("100000000000000001:a-test-client-secret")}`,
    );
    expect(me.url.href).toBe("https://discord.com/api/v10/users/@me");
    expect(me.headers.get("authorization")).toBe("Bearer a-discord-access-token");

    const linkedAnswer = await claim(h, code);
    expect(linkedAnswer.status).toBe(200);
    const body = (await linkedAnswer.json()) as Record<string, string>;
    expect(body).toEqual({
      status: "linked",
      secret: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      discordUserId: READER,
      username: "markus",
    });
    // Stored as its SHA-256 alone, beside a Durable Object minted for the link; the request is
    // gone; the Discord token is nowhere.
    expect(h.bots.minted).toHaveLength(1);
    expect(h.rows("discord_links")).toEqual([
      {
        discord_user_id: READER,
        username: "markus",
        secret_hash: await sha256Hex(body.secret),
        do_id: h.bots.minted[0],
        created_at: NOW,
      },
    ]);
    expect(h.rows("discord_link_requests")).toEqual([]);
    const stored = JSON.stringify([h.rows("discord_links"), h.rows("discord_link_requests")]);
    expect(stored).not.toContain("a-discord-access-token");
    expect(stored).not.toContain(body.secret);
    // Linking asks no Durable Object anything: enrolling is the desktop's next step.
    expect(h.bots.calls).toEqual([]);

    // **Single use**: a second claim finds no request.
    const again = await claim(h, code);
    expect(again.status).toBe(410);
    expect(await again.json()).toMatchObject({ code: "link_expired" });
  });

  it("refuses a claim with another verifier, whatever state the request is in", async () => {
    const h = setup();
    internet();
    const { code } = await begin(h);
    const stranger = "somebody-else-who-saw-the-state-in-the-address-bar";
    const before = await claim(h, code, stranger);
    expect(before.status).toBe(403);
    expect(await before.json()).toMatchObject({ code: "link_mismatch" });

    await worker.fetch(callback(`code=good-code&state=${code}`), h.env);
    const after = await claim(h, code, stranger);
    expect(after.status).toBe(403);
    expect(h.rows("discord_links")).toEqual([]);
    // The request is still there for the desktop that holds the verifier.
    expect((await claim(h, code)).status).toBe(200);
  });

  it("answers 409 link_denied once the reader pressed Cancel on Discord's page, asking Discord nothing", async () => {
    const h = setup();
    const asked = internet();
    const { code } = await begin(h);
    const page = await worker.fetch(callback(`error=access_denied&state=${code}`), h.env);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Discord was not linked");
    expect(asked).toEqual([]);
    const answer = await claim(h, code);
    expect(answer.status).toBe(409);
    expect(await answer.json()).toMatchObject({ code: "link_denied" });
    expect(h.rows("discord_links")).toEqual([]);
    // Answered once: the request is gone with it.
    expect((await claim(h, code)).status).toBe(410);
  });

  it("answers 410 link_expired after ten minutes, and deletes the request", async () => {
    const h = setup();
    const { code } = await begin(h);
    vi.setSystemTime(NOW + LINK_REQUEST_TTL_MS);
    const answer = await claim(h, code);
    expect(answer.status).toBe(410);
    expect(await answer.json()).toMatchObject({ code: "link_expired" });
    expect(h.rows("discord_link_requests")).toEqual([]);
  });

  it("draws an expired page for a redirect after ten minutes, and asks Discord nothing", async () => {
    const h = setup();
    const asked = internet();
    const { code } = await begin(h);
    vi.setSystemTime(NOW + LINK_REQUEST_TTL_MS + 1);
    const page = await worker.fetch(callback(`code=good-code&state=${code}`), h.env);
    expect(page.status).toBe(410);
    expect(await page.text()).toContain("This sign-in has expired");
    expect(asked).toEqual([]);
  });

  it("leaves the request pending when Discord refuses the code", async () => {
    const h = setup();
    internet();
    const { code } = await begin(h);
    const page = await worker.fetch(callback(`code=a-bad-code&state=${code}`), h.env);
    expect(page.status).toBe(502);
    expect((await claim(h, code)).status).toBe(202);
  });

  it("refuses a redirect with no request, or one already finished", async () => {
    const h = setup();
    internet();
    expect((await worker.fetch(callback("code=good-code"), h.env)).status).toBe(400);
    expect(
      (await worker.fetch(callback(`code=good-code&state=${"A".repeat(32)}`), h.env)).status,
    ).toBe(410);
    const { code } = await begin(h);
    await worker.fetch(callback(`code=good-code&state=${code}`), h.env);
    expect((await worker.fetch(callback(`code=good-code&state=${code}`), h.env)).status).toBe(409);
  });

  it("refuses a claim that is not { code, verifier }", async () => {
    const h = setup();
    for (const body of [
      {},
      { code: "x", verifier: VERIFIER },
      { code: "A".repeat(32), verifier: "short" },
    ]) {
      const answer = await worker.fetch(desktop("POST", "/link/claim", jsonOf(body)), h.env);
      expect(answer.status).toBe(400);
    }
  });

  it("escapes a username Discord answers", async () => {
    const h = setup();
    internet({ user: { id: READER, username: "<img src=x onerror=alert(1)>" } });
    const { code } = await begin(h);
    const html = await (await worker.fetch(callback(`code=good-code&state=${code}`), h.env)).text();
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(escapeHtml(`<script>alert("x")</script> & 'y'`)).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;",
    );
  });
});

describe("linking again", () => {
  it("while linked replaces the secret and keeps the Durable Object", async () => {
    const h = setup();
    internet();
    await linked(h);
    const { secret } = await linkThrough(h);
    const rows = h.rows("discord_links");
    expect(rows).toHaveLength(1);
    expect(rows[0].do_id).toBe(DO_ID);
    expect(rows[0].secret_hash).toBe(await sha256Hex(secret));
    // The old secret stops working at once; the new one finds the same bot.
    expect((await worker.fetch(desktop("GET", "/link", { secret: SECRET }), h.env)).status).toBe(
      401,
    );
    expect((await worker.fetch(desktop("GET", "/link", { secret }), h.env)).status).toBe(200);
    expect(h.bots.calls).toEqual([{ id: DO_ID, method: "status" }]);
  });

  it("after an unlink mints a fresh Durable Object", async () => {
    const h = setup();
    internet();
    await linked(h);
    expect((await worker.fetch(desktop("DELETE", "/link", { secret: SECRET }), h.env)).status).toBe(
      204,
    );
    await linkThrough(h);
    const rows = h.rows("discord_links");
    expect(rows).toHaveLength(1);
    expect(rows[0].do_id).not.toBe(DO_ID);
    expect(rows[0].do_id).toBe(h.bots.minted.at(-1));
  });
});

describe("the bearer routes", () => {
  it("answer 401 not_linked without a secret, or with one nobody holds, asking no bot", async () => {
    const h = harness();
    await linked(h);
    for (const secret of [undefined, "nonsense", "B".repeat(43)]) {
      for (const [method, path] of [
        ["POST", "/link/enroll"],
        ["GET", "/link"],
        ["DELETE", "/link"],
      ]) {
        const answer = await worker.fetch(
          desktop(method, path, {
            secret,
            ...(method === "POST" ? jsonOf({ invite: INVITE, capability: "read" }) : {}),
          }),
          h.env,
        );
        expect(answer.status, `${method} ${path}`).toBe(401);
        expect(await answer.json()).toEqual({
          error: "this desktop is not linked to a Discord account",
          code: "not_linked",
        });
      }
    }
    expect(h.bots.calls).toEqual([]);
    expect(h.rows("discord_links")).toHaveLength(1);
  });
});

describe("POST /link/enroll", () => {
  const enroll = (h: Harness, body: unknown = { invite: INVITE, capability: "read" }) =>
    worker.fetch(desktop("POST", "/link/enroll", { secret: SECRET, ...jsonOf(body) }), h.env);

  it("hands the invite to the link's Durable Object and answers its three public values", async () => {
    const h = harness();
    await linked(h);
    const answer = await enroll(h);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({
      deviceId: "the-bots-device-id",
      x25519: "x".repeat(43),
      ed25519: "e".repeat(43),
    });
    expect(h.bots.calls).toEqual([
      { id: DO_ID, method: "enroll", arg: { invite: INVITE, capability: "read" } },
    ]);
  });

  it("maps each refusal of the Durable Object's to the design's status", async () => {
    const h = harness();
    await linked(h);
    for (const [code, status] of [
      ["already_enrolled", 409],
      ["bad_invite", 422],
      ["pairing_failed", 502],
    ] as const) {
      h.bots.answers.enroll = { ok: false, code, error: `the bot says ${code}` };
      const answer = await enroll(h);
      expect(answer.status, code).toBe(status);
      expect(await answer.json()).toEqual({ error: `the bot says ${code}`, code });
    }
  });

  it("answers 502 pairing_failed when the Durable Object cannot be reached", async () => {
    const h = harness();
    await linked(h);
    h.bots.down = true;
    const answer = await enroll(h);
    expect(answer.status).toBe(502);
    expect(await answer.json()).toMatchObject({ code: "pairing_failed" });
  });

  it('refuses a body that is not { invite, capability: "read" }, before any Durable Object', async () => {
    const h = harness();
    await linked(h);
    for (const body of [
      {},
      { invite: INVITE },
      { invite: INVITE, capability: "add" },
      { invite: INVITE, capability: "full" },
      { invite: "", capability: "read" },
      { invite: 7, capability: "read" },
      { invite: "x".repeat(MAX_INVITE_CHARS + 1), capability: "read" },
    ]) {
      const answer = await enroll(h, body);
      expect(answer.status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    expect(h.bots.calls).toEqual([]);
  });
});

describe("GET /link", () => {
  it("answers the link and what its Durable Object says of itself", async () => {
    const h = harness();
    await linked(h, { username: "markus" });
    h.bots.answers.status = {
      enrolled: true,
      deviceId: "the-bots-device-id",
      paired: false,
      lastPullAt: null,
      error: "a sentence the desktop does not show",
    };
    const answer = await worker.fetch(desktop("GET", "/link", { secret: SECRET }), h.env);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({
      discordUserId: READER,
      username: "markus",
      enrolled: true,
      deviceId: "the-bots-device-id",
      paired: false,
      lastPullAt: null,
    });
    expect(h.bots.calls).toEqual([{ id: DO_ID, method: "status" }]);
  });

  it("answers 502 bot_unavailable when the Durable Object cannot be reached", async () => {
    const h = harness();
    await linked(h);
    h.bots.down = true;
    const answer = await worker.fetch(desktop("GET", "/link", { secret: SECRET }), h.env);
    expect(answer.status).toBe(502);
    expect(await answer.json()).toMatchObject({ code: "bot_unavailable" });
  });
});

describe("DELETE /link", () => {
  it("unlinks the Durable Object, then deletes the row", async () => {
    const h = harness();
    await linked(h);
    await linked(h, {
      user: "200000000000000009",
      secret: "another-link-secret-of-forty-three-characte",
      doId: "e1".repeat(32),
    });
    const answer = await worker.fetch(desktop("DELETE", "/link", { secret: SECRET }), h.env);
    expect(answer.status).toBe(204);
    expect(await answer.text()).toBe("");
    expect(h.bots.calls).toEqual([{ id: DO_ID, method: "unlink" }]);
    expect(h.rows("discord_links").map((row) => row.discord_user_id)).toEqual([
      "200000000000000009",
    ]);
    expect((await worker.fetch(desktop("GET", "/link", { secret: SECRET }), h.env)).status).toBe(
      401,
    );
  });

  it("keeps the row when the Durable Object cannot be reached, so the desktop can try again", async () => {
    const h = harness();
    await linked(h);
    h.bots.down = true;
    const answer = await worker.fetch(desktop("DELETE", "/link", { secret: SECRET }), h.env);
    expect(answer.status).toBe(502);
    expect(await answer.json()).toMatchObject({ code: "bot_unavailable" });
    expect(h.rows("discord_links")).toHaveLength(1);
    h.bots.down = false;
    expect((await worker.fetch(desktop("DELETE", "/link", { secret: SECRET }), h.env)).status).toBe(
      204,
    );
    expect(h.rows("discord_links")).toEqual([]);
  });
});

describe("the daily sweep", () => {
  it("deletes the link requests past their ten minutes and nothing else", async () => {
    const h = setup();
    const stale = await begin(h);
    vi.setSystemTime(NOW + 5 * 60 * 1000);
    const fresh = await begin(h);
    await linked(h);
    await worker.scheduled(
      { scheduledTime: NOW + LINK_REQUEST_TTL_MS, cron: "45 3 * * *", noRetry() {} },
      h.env,
    );
    expect(h.rows("discord_link_requests").map((row) => row.code)).toEqual([fresh.code]);
    expect(stale.code).not.toBe(fresh.code);
    expect(h.rows("discord_links")).toHaveLength(1);
  });
});
