// `pnpm discord:register` against a fake `fetch`: it refuses without both values, asks for a
// client-credentials token and `PUT`s the whole list with it, and says no credential — not on
// success, not in a refusal. Nothing here reaches Discord.
import { describe, expect, it } from "vitest";
import { COMMANDS } from "../infrastructure/discord-worker/src/commands.ts";
import { DISCORD_API, REQUIRED, SCOPE, USER_AGENT, refusal, register } from "./discord-register.ts";

const ID = "100000000000000001";
const SECRET = "a-test-client-secret-nobody-holds";
const TOKEN = "a-client-credentials-token";

interface Asked {
  url: string;
  init: RequestInit;
}

/** Discord's two endpoints, answering `token` and `put` as given. */
function discord(options: { token?: number; put?: number } = {}) {
  const asked: Asked[] = [];
  const fetcher = (url: string, init: RequestInit) => {
    asked.push({ url, init });
    if (url.endsWith("/oauth2/token")) {
      const status = options.token ?? 200;
      return Promise.resolve(
        Response.json(
          status === 200
            ? { access_token: TOKEN, token_type: "Bearer" }
            : { error: "invalid_client" },
          { status },
        ),
      );
    }
    const status = options.put ?? 200;
    const sent = JSON.parse(String(init.body)) as { name: string }[];
    return Promise.resolve(
      status === 200
        ? Response.json(sent.map((command, n) => ({ id: String(n), ...command })))
        : new Response('{"message":"Invalid Form Body"}', { status }),
    );
  };
  return { asked, fetcher };
}

describe("discord:register", () => {
  it("refuses without both values, before any request", async () => {
    for (const env of [
      {},
      { DISCORD_APPLICATION_ID: ID },
      { DISCORD_CLIENT_SECRET: SECRET },
      { DISCORD_APPLICATION_ID: " ", DISCORD_CLIENT_SECRET: SECRET },
    ]) {
      const { asked, fetcher } = discord();
      await expect(register(env, fetcher)).rejects.toThrow(/^Set DISCORD_/);
      expect(asked).toEqual([]);
    }
    expect(refusal({})).toBe(
      `Set ${REQUIRED.join(" and ")} in the environment first: the application's id and its OAuth2 client secret, from the Discord developer portal. Nothing was sent.`,
    );
  });

  it("refuses an application id that is not one", async () => {
    const { asked, fetcher } = discord();
    await expect(
      register({ DISCORD_APPLICATION_ID: "my-app", DISCORD_CLIENT_SECRET: SECRET }, fetcher),
    ).rejects.toThrow("DISCORD_APPLICATION_ID is not an application id");
    expect(asked).toEqual([]);
  });

  it("asks for a client-credentials token, then PUTs the whole list as the global commands", async () => {
    const { asked, fetcher } = discord();
    const names = await register(
      { DISCORD_APPLICATION_ID: ID, DISCORD_CLIENT_SECRET: SECRET },
      fetcher,
    );
    expect(names).toEqual(["collection", "wishlist", "card-search", "deck"]);

    const [token, put] = asked;
    expect(token.url).toBe(`${DISCORD_API}/oauth2/token`);
    expect(token.init.method).toBe("POST");
    const tokenHeaders = new Headers(token.init.headers);
    expect(tokenHeaders.get("authorization")).toBe(`Basic ${btoa(`${ID}:${SECRET}`)}`);
    expect(tokenHeaders.get("user-agent")).toBe(USER_AGENT);
    expect(Object.fromEntries(new URLSearchParams(String(token.init.body)))).toEqual({
      grant_type: "client_credentials",
      scope: SCOPE,
    });

    expect(put.url).toBe(`${DISCORD_API}/applications/${ID}/commands`);
    expect(put.init.method).toBe("PUT");
    const putHeaders = new Headers(put.init.headers);
    expect(putHeaders.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(putHeaders.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(put.init.body))).toEqual(COMMANDS);
    // The secret went to the token endpoint alone, and only inside the Basic header.
    expect(String(put.init.body)).not.toContain(SECRET);
    expect(JSON.stringify([...putHeaders])).not.toContain(SECRET);
  });

  it("says which step Discord refused, and never a credential", async () => {
    for (const [options, wanted] of [
      [{ token: 401 }, "Discord refused the client credentials (401)"],
      [{ put: 400 }, 'Discord refused the commands (400): {"message":"Invalid Form Body"}'],
    ] as const) {
      const { fetcher } = discord(options);
      const error = await register(
        { DISCORD_APPLICATION_ID: ID, DISCORD_CLIENT_SECRET: SECRET },
        fetcher,
      ).catch((caught: Error) => caught);
      expect((error as Error).message).toContain(wanted);
      expect((error as Error).message).not.toContain(SECRET);
      expect((error as Error).message).not.toContain(TOKEN);
    }
  });
});
