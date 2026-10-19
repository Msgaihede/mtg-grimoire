import { describe, expect, it } from "vitest";
import { Device, STALE_MS } from "./device";
import { ENGINE_FAILED, NOT_PAIRED, NOT_YET } from "./interaction";
import { FakeEngine, PAIRED, host, signer } from "./fake";

const NOW = 1_760_000_060_000;
const STAMP = String(Math.floor(NOW / 1000));

async function setUp(engine = new FakeEngine()) {
  const key = await signer();
  const made = host(engine, key.publicKeyHex, NOW);
  const device = new Device(made.host);
  const ask = async (interaction: unknown) => {
    const body = JSON.stringify(interaction);
    return device.interaction({ body, signature: await key.sign(STAMP, body), timestamp: STAMP });
  };
  return { engine, key, device, ask, ...made };
}

const search = (command: string, card: string) => ({
  type: 2,
  data: {
    name: command,
    options: [{ type: 1, name: "search", options: [{ type: 3, name: "card", value: card }] }],
  },
});

describe("an interaction", () => {
  it("is refused when Discord's signature does not verify here, whatever the front said", async () => {
    const { device, engine } = await setUp();
    const body = JSON.stringify(search("collection", "Sol Ring"));
    const other = await signer();
    const answer = await device.interaction({
      body,
      signature: await other.sign(STAMP, body),
      timestamp: STAMP,
    });
    expect(answer.status).toBe(401);
    expect(engine.calls).toEqual([]);
  });

  it("asks the engine for the card and answers in the channel", async () => {
    const { ask, engine } = await setUp();
    engine.holding = {
      name: "Sol Ring",
      image: null,
      typeLine: null,
      total: 2,
      lines: [
        {
          quantity: 2,
          setName: "Commander 2021",
          setCode: "c21",
          collectorNumber: "263",
          finish: "foil",
          folder: null,
          priceUsd: null,
        },
      ],
      more: 0,
    };
    const answer = await ask(search("collection", "sol ring"));
    expect(engine.calls).toEqual(["collection sol ring"]);
    const sent = JSON.parse(answer.body);
    expect(sent.data.embeds[0].description).toBe("2× Commander 2021 (C21) #263 · Foil");
  });

  it("answers a wish by the wishlist, and an empty one privately", async () => {
    const { ask, engine } = await setUp();
    const answer = await ask(search("wishlist", "Black Lotus"));
    expect(engine.calls).toEqual(["wishlist Black Lotus"]);
    expect(JSON.parse(answer.body).data.flags).toBe(64);
  });

  it("asks the engine's names for an autocomplete, by the list the command is about", async () => {
    const { ask, engine } = await setUp();
    engine.choices = [{ name: "Sol Ring", value: "Sol Ring" }];
    const focused = {
      type: 4,
      data: {
        name: "collection",
        options: [
          {
            type: 1,
            name: "search",
            options: [{ type: 3, name: "card", value: "so", focused: true }],
          },
        ],
      },
    };
    const sent = JSON.parse((await ask(focused)).body);
    expect(sent).toEqual({ type: 8, data: { choices: [{ name: "Sol Ring", value: "Sol Ring" }] } });
    await ask({
      type: 4,
      data: { name: "deck", options: [{ type: 3, name: "deck", value: "bu", focused: true }] },
    });
    expect(engine.calls).toEqual(["names collection so 25", "names deck bu 25"]);
  });

  it("posts a deck through the export writer", async () => {
    const { ask, engine } = await setUp();
    engine.deck = {
      deck: { uid: "u", name: "Burn", format: "modern", cards: 4 },
      cards: [
        {
          name: "Lightning Bolt",
          quantity: 4,
          setCode: "m10",
          collectorNumber: "146",
          finish: null,
          lang: "en",
          categoryName: "Main deck",
          categoryKind: "main",
          categoryActive: true,
          condition: null,
          tradelistQuantity: null,
          purchasePrice: null,
          purchaseCurrency: null,
          acquiredAt: null,
          acquisitionSource: null,
          serialNumber: null,
          grading: null,
          altered: null,
          signed: null,
          proxy: null,
          misprint: null,
          tags: null,
          notes: null,
          setName: "Magic 2010",
          rarity: "common",
          typeLine: "Instant",
          unitPrice: 1,
          labelName: null,
          labelColor: null,
          legalities: null,
        },
      ],
    };
    const answer = await ask({
      type: 2,
      data: {
        name: "deck",
        options: [
          { type: 3, name: "deck", value: "u" },
          { type: 3, name: "format", value: "moxfield" },
        ],
      },
    });
    expect(engine.calls).toEqual(["deck u"]);
    expect(JSON.parse(answer.body).data.content).toBe(
      "**Burn** · Moxfield\n```\nDeck\n4 Lightning Bolt (M10) 146\n```",
    );
  });

  it("is told plainly while the bot is not paired, or has not pulled yet", async () => {
    const { ask, engine } = await setUp();
    engine.state = { ...PAIRED, paired: false };
    expect(JSON.parse((await ask(search("collection", "x"))).body).data.content).toBe(NOT_PAIRED);
    engine.state = { ...PAIRED, lastPullAt: null };
    expect(JSON.parse((await ask(search("collection", "x"))).body).data.content).toBe(NOT_YET);
    expect(engine.calls).toEqual([]);
  });

  it("hides the engine's own words when a read fails", async () => {
    const { ask, engine } = await setUp();
    engine.broken = true;
    const sent = JSON.parse((await ask(search("collection", "x"))).body);
    expect(sent.data.content).toBe(ENGINE_FAILED);
    expect(sent.data.flags).toBe(64);
  });

  it("answers Discord's ping", async () => {
    const { ask } = await setUp();
    expect(JSON.parse((await ask({ type: 1 })).body)).toEqual({ type: 1 });
  });
});

describe("freshness", () => {
  it("asks for an alarm now when the last pull is over two minutes old, and answers anyway", async () => {
    const { ask, engine, alarms } = await setUp();
    engine.state = { ...PAIRED, lastPullAt: NOW - STALE_MS - 1 };
    const answer = await ask(search("collection", "x"));
    expect(alarms.sets).toEqual([NOW]);
    expect(answer.status).toBe(200);
    expect(engine.calls).toEqual(["collection x"]);
    expect(engine.calls).not.toContain("advance");
  });

  it("asks for nothing when the pull is fresh, or an alarm is due sooner", async () => {
    const { ask, engine, alarms } = await setUp();
    engine.state = { ...PAIRED, lastPullAt: NOW - 1000 };
    await ask(search("collection", "x"));
    expect(alarms.sets).toEqual([]);
    engine.state = { ...PAIRED, lastPullAt: NOW - STALE_MS - 1 };
    alarms.at = NOW - 5;
    await ask(search("collection", "x"));
    expect(alarms.sets).toEqual([]);
  });

  it("asks for nothing before the bot is paired", async () => {
    const { ask, engine, alarms } = await setUp();
    engine.state = { ...PAIRED, paired: false, lastPullAt: null };
    await ask(search("collection", "x"));
    expect(alarms.sets).toEqual([]);
  });
});

describe("enrolling, alarms and unlinking", () => {
  it("enrolls through the engine and polls the rendezvous soon", async () => {
    const { device, engine, alarms } = await setUp();
    const answer = await device.enroll({ invite: "INVITE", capability: "add" });
    expect(answer).toEqual({ ok: true, deviceId: "dev", x25519: "x", ed25519: "e" });
    expect(engine.calls).toEqual(["enroll INVITE add"]);
    expect(alarms.sets).toEqual([NOW + 1500]);
  });

  it("refuses an enrolment that asks for anything but adding — reading too", async () => {
    const { device, engine } = await setUp();
    for (const capability of ["read", "full"]) {
      const answer = await device.enroll({ invite: "INVITE", capability: capability as "add" });
      expect(answer).toMatchObject({ ok: false, code: "bad_invite" });
    }
    expect(engine.calls).toEqual([]);
  });

  it("sets the alarm the engine's step asks for", async () => {
    const { device, engine, alarms } = await setUp();
    engine.advanced = '{"nextInMs":60000,"purge":false,"did":"pulled"}';
    await device.alarm();
    expect(alarms.sets).toEqual([NOW + 60000]);
  });

  it("deletes everything when the engine's step says to purge", async () => {
    const { device, engine, record, alarms } = await setUp();
    alarms.at = NOW + 1;
    engine.advanced = '{"nextInMs":null,"purge":true,"did":"lapsed"}';
    await device.alarm();
    expect(engine.closed).toBe(true);
    expect(record.purged).toBe(1);
    expect(alarms.at).toBeNull();
  });

  it("unlinks by closing the engine and deleting its storage, then opens afresh if asked again", async () => {
    const { device, engine, record } = await setUp();
    expect((await device.status()).paired).toBe(true);
    await device.unlink();
    expect(engine.closed).toBe(true);
    expect(record.purged).toBe(1);
    await device.status();
    expect(record.opened).toBe(2);
  });

  it("says why when the engine would not open", async () => {
    const key = await signer();
    const made = host(new FakeEngine(), key.publicKeyHex, NOW);
    made.host.open = () => {
      throw new Error("BOT_KEK is not base64url");
    };
    const device = new Device(made.host);
    expect(await device.status()).toEqual({
      enrolled: false,
      deviceId: null,
      paired: false,
      lastPullAt: null,
      error: "BOT_KEK is not base64url",
    });
    expect(await device.enroll({ invite: "x", capability: "add" })).toMatchObject({
      ok: false,
      code: "pairing_failed",
    });
  });
});
