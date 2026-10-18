import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DELVER,
  DO_ID,
  READER,
  SOL_RING,
  STRANGER,
  asMember,
  asUser,
  harness,
  internet,
  interaction,
  linked,
  signedRequest,
  signer,
  slash,
  untouchable,
  type Harness,
  type Signer,
} from "./fake";
import worker from "./index";
import { BOT_DOWN, NOT_LINKED } from "./interactions";
import { ACCEPT, USER_AGENT } from "./scryfall";

/**
 * What `/interactions` answers once Discord's signature has verified (`verify.test.ts` is the
 * door): `/card-search` and its autocomplete from Scryfall, here; a reader with no link, told
 * where the switch is; and everything else handed to the reader's own Durable Object, exactly as
 * Discord signed it, with its answer returned verbatim.
 */

let key: Signer;
let h: Harness;

beforeEach(async () => {
  key = await signer();
  h = harness({ publicKey: key.publicKeyHex });
});
afterEach(() => vi.unstubAllGlobals());

const ask = async (body: unknown) => worker.fetch(await interaction(key, body), h.env);
const AUTOCOMPLETE = 4;

describe("/card-search, answered here from Scryfall", () => {
  it("posts the card publicly, for a reader who has linked nothing, asking no database and no bot", async () => {
    h.env.DB = untouchable;
    const asked = internet();
    const answer = await ask(slash("card-search", null, [{ name: "card", value: "sol rin" }]));
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as { type: number; data: Record<string, unknown> };
    expect(body.type).toBe(4);
    expect(body.data.flags).toBeUndefined();
    expect(body.data.allowed_mentions).toEqual({ parse: [] });
    expect(body.data.embeds).toEqual([
      {
        title: "Sol Ring {1}",
        url: SOL_RING.scryfall_uri,
        description: "Artifact\n{T}: Add {C}{C}.",
        footer: { text: "Commander 2021 (C21) #263 · $1.50" },
        image: { url: SOL_RING.image_uris!.normal },
      },
    ]);
    expect(asked).toHaveLength(1);
    expect(asked[0].url.href).toBe("https://api.scryfall.com/cards/named?fuzzy=sol%20rin");
    expect(asked[0].headers.get("user-agent")).toBe(USER_AGENT);
    expect(asked[0].headers.get("accept")).toBe(ACCEPT);
    expect(h.bots.calls).toEqual([]);
  });

  it("draws a double-faced card's two faces, each by name", async () => {
    internet();
    const answer = await ask(slash("card-search", null, [{ name: "card", value: "delver" }]));
    const { data } = (await answer.json()) as { data: { embeds: Record<string, unknown>[] } };
    expect(data.embeds[0].title).toBe("Delver of Secrets // Insectile Aberration {U}");
    expect(data.embeds[0].description).toContain("**Delver of Secrets {U}**");
    expect(data.embeds[0].description).toContain(
      "**Insectile Aberration**\nCreature — Human Insect",
    );
    expect(data.embeds[0].image).toEqual({ url: DELVER.card_faces![0].image_uris!.normal });
  });

  it("says privately that Scryfall knows no such card, escaping what was typed", async () => {
    internet();
    const answer = await ask(slash("card-search", null, [{ name: "card", value: "**nothing**" }]));
    const { data } = (await answer.json()) as { data: Record<string, unknown> };
    expect(data.flags).toBe(64);
    expect(data.content).toBe("Scryfall knows no card called **\\*\\*nothing\\*\\***.");
  });

  it("says privately that Scryfall could not be reached, whether it is down or failing", async () => {
    for (const options of [{ down: true }, { status: 503 }]) {
      internet(options);
      const answer = await ask(slash("card-search", null, [{ name: "card", value: "sol ring" }]));
      expect(answer.status).toBe(200);
      const { data } = (await answer.json()) as { data: Record<string, unknown> };
      expect(data.flags).toBe(64);
      expect(data.content).toBe("Scryfall could not be reached just now. Try again in a moment.");
    }
  });

  it("completes a card's name from Scryfall's autocomplete", async () => {
    h.env.DB = untouchable;
    const asked = internet();
    const answer = await ask(
      slash(
        "card-search",
        null,
        [{ name: "card", value: "ring", focused: true }],
        asUser(),
        AUTOCOMPLETE,
      ),
    );
    expect(await answer.json()).toEqual({
      type: 8,
      data: { choices: [{ name: "Sol Ring", value: "Sol Ring" }] },
    });
    expect(asked[0].url.href).toBe("https://api.scryfall.com/cards/autocomplete?q=ring");
    expect(asked[0].headers.get("user-agent")).toBe(USER_AGENT);
    expect(asked[0].headers.get("accept")).toBe(ACCEPT);
    expect(h.bots.calls).toEqual([]);
  });

  it("answers no choices when Scryfall fails, and asks it nothing for one character", async () => {
    for (const options of [{ down: true }, { status: 500 }]) {
      internet(options);
      const answer = await ask(
        slash(
          "card-search",
          null,
          [{ name: "card", value: "sol", focused: true }],
          asUser(),
          AUTOCOMPLETE,
        ),
      );
      expect(answer.status).toBe(200);
      expect(await answer.json()).toEqual({ type: 8, data: { choices: [] } });
    }
    const asked = internet();
    await ask(
      slash(
        "card-search",
        null,
        [{ name: "card", value: "s", focused: true }],
        asUser(),
        AUTOCOMPLETE,
      ),
    );
    expect(asked).toEqual([]);
  });

  it("holds each choice to Discord's hundred characters and twenty-five choices", async () => {
    const long = "A".repeat(150);
    const many = Array.from({ length: 30 }, (_, n) => ({ ...SOL_RING, name: `Ring ${n}` }));
    internet({ cards: [{ ...SOL_RING, name: long }, ...many] });
    const wide = await ask(
      slash(
        "card-search",
        null,
        [{ name: "card", value: "AAAA", focused: true }],
        asUser(),
        AUTOCOMPLETE,
      ),
    );
    const { data } = (await wide.json()) as {
      data: { choices: { name: string; value: string }[] };
    };
    expect(data.choices[0].name).toHaveLength(100);
    expect(data.choices[0].value).toHaveLength(100);
    const ring = await ask(
      slash(
        "card-search",
        null,
        [{ name: "card", value: "ring", focused: true }],
        asUser(),
        AUTOCOMPLETE,
      ),
    );
    const listed = (await ring.json()) as { data: { choices: unknown[] } };
    expect(listed.data.choices).toHaveLength(25);
  });
});

describe("every other command, for a reader with no link", () => {
  it("is told privately where to switch the integration on, and no bot is asked", async () => {
    for (const [name, sub, option] of [
      ["collection", "search", "card"],
      ["wishlist", "search", "card"],
      ["deck", null, "deck"],
    ] as const) {
      for (const who of [asUser(), asMember()]) {
        const answer = await ask(slash(name, sub, [{ name: option, value: "x" }], who));
        expect(answer.status).toBe(200);
        expect(await answer.json()).toEqual({
          type: 4,
          data: { content: NOT_LINKED, allowed_mentions: { parse: [] }, flags: 64 },
        });
      }
    }
    expect(NOT_LINKED).toContain("Switch on Discord in MTG Grimoire → Settings → Integrations");
    expect(h.bots.calls).toEqual([]);
  });

  it("gets no choices from an autocomplete, which can carry no sentence", async () => {
    const answer = await ask(
      slash(
        "collection",
        "search",
        [{ name: "card", value: "sol", focused: true }],
        asUser(),
        AUTOCOMPLETE,
      ),
    );
    expect(await answer.json()).toEqual({ type: 8, data: { choices: [] } });
    expect(h.bots.calls).toEqual([]);
  });

  it("is not answered from somebody else's link", async () => {
    await linked(h, { user: STRANGER });
    const answer = await ask(slash("collection", "search", [{ name: "card", value: "x" }]));
    expect(((await answer.json()) as { data: { content: string } }).data.content).toBe(NOT_LINKED);
    expect(h.bots.calls).toEqual([]);
  });

  it("refuses an interaction that names no user", async () => {
    const answer = await ask({ type: 2, data: { name: "deck", options: [] } });
    expect(answer.status).toBe(400);
  });
});

describe("every other command, for a linked reader", () => {
  it("is handed to the link's Durable Object exactly as Discord signed it, and its answer returned verbatim", async () => {
    await linked(h);
    h.bots.answers.interaction = {
      status: 200,
      contentType: "multipart/form-data; boundary=x",
      body: "--x\r\nthe bot's own bytes\r\n--x--",
    };
    // A body spelled the way Discord spells one — spacing and key order that a re-serialise
    // would change — so "exactly" is something this test can fail.
    const text = `{"type":2,  "data":{"name":"deck","options":[{"type":3,"name":"deck","value":"Atraxa"}]},"user":{"id":"${READER}"}}`;
    const request = await signedRequest(key, text, { timestamp: "1760700123" });
    const signature = request.headers.get("x-signature-ed25519");
    const answer = await worker.fetch(request, h.env);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("multipart/form-data; boundary=x");
    expect(await answer.text()).toBe("--x\r\nthe bot's own bytes\r\n--x--");
    expect(h.bots.calls).toEqual([
      {
        id: DO_ID,
        method: "interaction",
        arg: { body: text, signature, timestamp: "1760700123" },
      },
    ]);
  });

  it("finds the link by `member.user` in a server and `user` in a DM", async () => {
    await linked(h);
    await ask(slash("collection", "search", [{ name: "card", value: "Sol Ring" }], asMember()));
    await ask(slash("wishlist", "search", [{ name: "card", value: "Sol Ring" }], asUser()));
    expect(h.bots.calls.map(({ id, method }) => `${id} ${method}`)).toEqual([
      `${DO_ID} interaction`,
      `${DO_ID} interaction`,
    ]);
  });

  it("hands over an autocomplete, and a status the Durable Object chose, as they are", async () => {
    await linked(h);
    h.bots.answers.interaction = (req) => ({
      status: 401,
      contentType: "text/plain",
      body: `refused ${JSON.parse(req.body).type}`,
    });
    const answer = await ask(
      slash("deck", null, [{ name: "deck", value: "atr", focused: true }], asUser(), AUTOCOMPLETE),
    );
    expect(answer.status).toBe(401);
    expect(answer.headers.get("content-type")).toBe("text/plain");
    expect(await answer.text()).toBe("refused 4");
  });

  it("says privately that the bot could not answer when its Durable Object throws", async () => {
    await linked(h);
    h.bots.down = true;
    const command = await ask(slash("deck", null, [{ name: "deck", value: "Atraxa" }]));
    expect(command.status).toBe(200);
    expect(((await command.json()) as { data: { content: string; flags: number } }).data).toEqual({
      content: BOT_DOWN,
      allowed_mentions: { parse: [] },
      flags: 64,
    });
    const typing = await ask(
      slash("deck", null, [{ name: "deck", value: "atr", focused: true }], asUser(), AUTOCOMPLETE),
    );
    expect(await typing.json()).toEqual({ type: 8, data: { choices: [] } });
  });

  it("does not hand `/card-search` to the Durable Object, linked or not", async () => {
    await linked(h);
    internet();
    await ask(slash("card-search", null, [{ name: "card", value: "sol ring" }]));
    expect(h.bots.calls).toEqual([]);
  });
});
