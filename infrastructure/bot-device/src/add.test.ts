import { describe, expect, it } from "vitest";
import { ADD_FAILED, CANCELLED, EXPIRED, NOT_YOURS, SCRYFALL_DOWN, pressed } from "./add";
import { Device } from "./device";
import { FakeEngine, PAIRED, host, signer } from "./fake";
import { ENGINE_FAILED, NOT_PAIRED, NOT_YET } from "./interaction";
import { PROPOSAL_TTL_MS } from "./proposals";
import { USER_AGENT } from "./scryfall";

/**
 * `/collection add` and `/wishlist add` (the Discord spec, §14.4), through the device as the
 * front hands them over: the checks that answer at once, the deferred reply and the work after it
 * (Scryfall, the proposal, the reply's edit), and every way a press on Confirm or Cancel can go.
 */

const NOW = 1_760_000_060_000;
const STAMP = String(Math.floor(NOW / 1000));
const READER = "200000000000000001";
const STRANGER = "200000000000000002";
const APP = "100000000000000001";

const BOLT_2X2 = {
  object: "card",
  id: "bolt-2x2",
  oracle_id: "oracle-bolt",
  name: "Lightning Bolt",
  set: "2x2",
  set_name: "Double Masters 2022",
  collector_number: "117",
  lang: "en",
  finishes: ["nonfoil", "foil"],
};
const BOLT_DEFAULT = {
  ...BOLT_2X2,
  id: "bolt-m10",
  set: "m10",
  set_name: "Magic 2010",
  collector_number: "146",
};

async function setUp(engine = new FakeEngine()) {
  const key = await signer();
  const made = host(engine, key.publicKeyHex, NOW);
  made.record.cards["/cards/2x2/117"] = BOLT_2X2;
  made.record.cards["/cards/named?exact=Lightning%20Bolt"] = BOLT_DEFAULT;
  const device = new Device(made.host);
  const ask = async (interaction: unknown) => {
    const body = JSON.stringify(interaction);
    return device.interaction({ body, signature: await key.sign(STAMP, body), timestamp: STAMP });
  };
  /** The deferred reply's edit, once the work after the answer has run. */
  const edited = async () => {
    await made.settle();
    const patch = made.asked.find((r) => r.method === "PATCH");
    return patch === undefined ? null : (JSON.parse(patch.body) as Record<string, unknown>);
  };
  return { engine, device, ask, edited, ...made };
}

/** A clock's own Discord stamp: a press made later is signed later, as Discord would. */
const stampOf = (now: number) => String(Math.floor(now / 1000));

const add = (
  list: "collection" | "wishlist",
  options: { name: string; type?: number; value: unknown }[],
  user = READER,
) => ({
  type: 2,
  id: "300000000000000001",
  application_id: APP,
  token: "an-interaction-token",
  data: {
    name: list,
    type: 1,
    options: [
      {
        type: 1,
        name: "add",
        options: options.map(({ type, ...rest }) => ({ type: type ?? 3, ...rest })),
      },
    ],
  },
  user: { id: user },
});

const click = (customId: string, user = READER) => ({
  type: 3,
  application_id: APP,
  token: "a-press-token",
  data: { custom_id: customId, component_type: 2 },
  member: { user: { id: user } },
});

const body = async (reply: { body: string }) => JSON.parse(reply.body);

/** The proposal's id, from its Confirm button. */
function idOf(message: Record<string, unknown> | null): string {
  const rows = message?.components as { components: { custom_id: string }[] }[];
  return rows[0].components[0].custom_id.slice("add:confirm:".length);
}

describe("an add command", () => {
  it("answers at once with a deferred ephemeral reply, then edits it into the proposal", async () => {
    const { ask, edited, asked, engine, proposals } = await setUp();
    const reply = await ask(
      add("collection", [
        { name: "card", value: "Lightning Bolt" },
        { name: "set", value: "2x2/117" },
        { name: "quantity", type: 4, value: 2 },
        { name: "finish", value: "foil" },
      ]),
    );
    expect(await body(reply)).toEqual({ type: 5, data: { flags: 64 } });
    // The answer did not wait for the work: no reply has been edited yet.
    expect(asked.filter((r) => r.method === "PATCH")).toEqual([]);
    expect(engine.calls).toEqual(["target collection "]);

    const message = await edited();
    expect(asked[0].url).toBe("https://scryfall.test/cards/2x2/117");
    expect(asked[0].headers.get("user-agent")).toBe(USER_AGENT);
    expect(asked[1].url).toBe(
      `https://discord.test/api/v10/webhooks/${APP}/an-interaction-token/messages/@original`,
    );
    expect(message!.content).toBe(
      "Add 2× Lightning Bolt — Double Masters 2022 (2X2) #117, foil — to Added from Discord?",
    );
    const id = idOf(message);
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(message!.components).toEqual([
      {
        type: 1,
        components: [
          { type: 2, style: 3, label: "Confirm", custom_id: `add:confirm:${id}` },
          { type: 2, style: 2, label: "Cancel", custom_id: `add:cancel:${id}` },
        ],
      },
    ]);
    expect(message!.allowed_mentions).toEqual({ parse: [] });
    expect(proposals.count()).toBe(1);
    expect(engine.adds).toEqual([]);
  });

  it("takes Scryfall's default printing without a set, its first finish, and names both", async () => {
    const { ask, edited, asked } = await setUp();
    await ask(add("collection", [{ name: "card", value: "Lightning Bolt" }]));
    const message = await edited();
    expect(asked[0].url).toBe("https://scryfall.test/cards/named?exact=Lightning%20Bolt");
    expect(message!.content).toBe(
      "Add 1× Lightning Bolt — Magic 2010 (M10) #146, nonfoil — to Added from Discord?",
    );
  });

  it("files a wish for any printing without a set, and a printing with one", async () => {
    const { ask, edited, engine, settle, asked } = await setUp();
    await ask(
      add("wishlist", [
        { name: "card", value: "Lightning Bolt" },
        { name: "finish", value: "foil" },
      ]),
    );
    const any = await edited();
    expect(any!.content).toBe("Add 1× Lightning Bolt — any printing, foil — to your wishlist?");
    expect(engine.calls).toEqual(["target wishlist "]);
    const confirmed = await ask(click(`add:confirm:${idOf(any)}`));
    expect((await body(confirmed)).type).toBe(7);
    expect(engine.adds).toEqual([
      {
        table: "wishlist",
        oracleId: "oracle-bolt",
        name: "Lightning Bolt",
        printing: null,
        preferredFinish: "foil",
        quantity: 1,
        folderUid: null,
      },
    ]);
    asked.length = 0;
    await ask(
      add("wishlist", [
        { name: "card", value: "Lightning Bolt" },
        { name: "set", value: "2x2/117" },
      ]),
    );
    await settle();
    const printed = JSON.parse(asked.find((r) => r.method === "PATCH")!.body);
    expect(printed.content).toBe(
      "Add 1× Lightning Bolt — Double Masters 2022 (2X2) #117 — to your wishlist?",
    );
  });

  it("refuses a finish the printing is not made in, a card Scryfall does not know, and says when it is down", async () => {
    const { ask, edited, record, asked, proposals } = await setUp();
    await ask(
      add("collection", [
        { name: "card", value: "Lightning Bolt" },
        { name: "set", value: "2x2/117" },
        { name: "finish", value: "etched" },
      ]),
    );
    expect((await edited())!.content).toBe("Double Masters 2022 (2X2) #117 is not made in etched.");
    asked.length = 0;
    await ask(add("collection", [{ name: "card", value: "No Such *Card*" }]));
    expect((await edited())!.content).toBe("Scryfall knows no card called **No Such \\*Card\\***.");
    asked.length = 0;
    record.scryfallStatus = 503;
    await ask(add("collection", [{ name: "card", value: "Lightning Bolt" }]));
    expect((await edited())!.content).toBe(SCRYFALL_DOWN);
    expect(proposals.count()).toBe(0);
  });

  it("refuses a printing of another card than the one named", async () => {
    const { ask, edited } = await setUp();
    await ask(
      add("collection", [
        { name: "card", value: "Sol Ring" },
        { name: "set", value: "2x2/117" },
      ]),
    );
    expect((await edited())!.content).toBe(
      "That printing is not **Sol Ring**. Pick the set again.",
    );
  });

  it("refuses at once, and privately, what the engine refuses: a folder, the default one missing, the quota", async () => {
    const { ask, engine, asked } = await setUp();
    for (const sentence of [
      "Name a folder, or switch Discord off and on in Settings to bring back Added from Discord.",
      "Discord has added as much as it may today; try again tomorrow.",
    ]) {
      engine.targeted = { refused: sentence };
      const reply = await body(
        await ask(
          add("collection", [
            { name: "card", value: "Lightning Bolt" },
            { name: "folder", value: "deck-uid" },
          ]),
        ),
      );
      expect(reply).toEqual({
        type: 4,
        data: { content: sentence, allowed_mentions: { parse: [] }, flags: 64 },
      });
    }
    expect(engine.calls).toEqual(["target collection deck-uid", "target collection deck-uid"]);
    expect(asked).toEqual([]);
  });

  it("refuses a quantity outside 1–99 and a card left empty, before anything else", async () => {
    const { ask, engine } = await setUp();
    for (const quantity of [0, 100, 1.5]) {
      const reply = await body(
        await ask(
          add("collection", [
            { name: "card", value: "Bolt" },
            { name: "quantity", type: 4, value: quantity },
          ]),
        ),
      );
      expect(reply.data.content).toBe("Add between 1 and 99 copies.");
    }
    expect(
      (await body(await ask(add("wishlist", [{ name: "card", value: " " }])))).data.content,
    ).toBe("Name a card to add.");
    expect(engine.calls).toEqual([]);
  });

  it("tells a reader the bot is not paired, or has not pulled, and defers nothing", async () => {
    const { ask, engine, asked } = await setUp();
    engine.state = { ...PAIRED, paired: false };
    expect(
      (await body(await ask(add("collection", [{ name: "card", value: "x" }])))).data.content,
    ).toBe(NOT_PAIRED);
    engine.state = { ...PAIRED, lastPullAt: null };
    expect(
      (await body(await ask(add("collection", [{ name: "card", value: "x" }])))).data.content,
    ).toBe(NOT_YET);
    expect(engine.calls).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("hides the engine's own words when it fails", async () => {
    const { ask, engine } = await setUp();
    engine.broken = true;
    expect(
      (await body(await ask(add("collection", [{ name: "card", value: "x" }])))).data.content,
    ).toBe(ENGINE_FAILED);
  });
});

describe("a press on the proposal", () => {
  async function proposed() {
    const key = await signer();
    const engine = new FakeEngine();
    const made = host(engine, key.publicKeyHex, NOW);
    made.record.cards["/cards/2x2/117"] = BOLT_2X2;
    const device = new Device(made.host);
    const send = async (interaction: unknown) => {
      const text = JSON.stringify(interaction);
      const stamp = stampOf(made.record.now);
      return device.interaction({
        body: text,
        signature: await key.sign(stamp, text),
        timestamp: stamp,
      });
    };
    await send(
      add("collection", [
        { name: "card", value: "Lightning Bolt" },
        { name: "set", value: "2x2/117" },
        { name: "quantity", type: 4, value: 2 },
        { name: "finish", value: "foil" },
        { name: "folder", value: "uid-binder" },
      ]),
    );
    engine.calls.length = 0;
    engine.targeted = { uid: "uid-binder", path: "Binder" };
    await made.settle();
    const patch = made.asked.find((r) => r.method === "PATCH")!;
    const id = idOf(JSON.parse(patch.body));
    made.asked.length = 0;
    return { engine, device, send, id, ...made };
  }

  it("Confirm emits the add, rewrites the message with no buttons, and asks for the push in a second — no network", async () => {
    const { send, id, engine, alarms, asked, proposals } = await proposed();
    const reply = await body(await send(click(`add:confirm:${id}`)));
    expect(reply).toEqual({
      type: 7,
      data: {
        content:
          "Added 2× Lightning Bolt — Double Masters 2022 (2X2) #117, foil — to Added from Discord. It reaches your devices on their next sync.",
        components: [],
        allowed_mentions: { parse: [] },
      },
    });
    expect(engine.adds).toEqual([
      {
        table: "collection",
        cardId: "bolt-2x2",
        setCode: "2x2",
        collectorNumber: "117",
        lang: "en",
        finish: "foil",
        quantity: 2,
        folderUid: "uid-added",
      },
    ]);
    expect(alarms.sets).toEqual([NOW + 1000]);
    expect(asked).toEqual([]);
    expect(proposals.count()).toBe(0);
    // A second press finds nothing.
    expect((await body(await send(click(`add:confirm:${id}`)))).data.content).toBe(EXPIRED);
    expect(engine.adds).toHaveLength(1);
  });

  it("Cancel deletes it and says so, with no buttons and no add", async () => {
    const { send, id, engine, proposals } = await proposed();
    expect(await body(await send(click(`add:cancel:${id}`)))).toEqual({
      type: 7,
      data: { content: CANCELLED, components: [], allowed_mentions: { parse: [] } },
    });
    expect(engine.adds).toEqual([]);
    expect(proposals.count()).toBe(0);
  });

  it("refuses somebody else's press privately, and the proposal stands", async () => {
    const { send, id, engine, proposals } = await proposed();
    const reply = await body(await send(click(`add:confirm:${id}`, STRANGER)));
    expect(reply).toEqual({
      type: 4,
      data: { content: NOT_YOURS, allowed_mentions: { parse: [] }, flags: 64 },
    });
    expect(engine.adds).toEqual([]);
    expect(proposals.count()).toBe(1);
    expect((await body(await send(click(`add:confirm:${id}`)))).type).toBe(7);
    expect(engine.adds).toHaveLength(1);
  });

  it("says an expired or unknown proposal has expired, and purges what is past its time", async () => {
    const { send, id, record, proposals, engine } = await proposed();
    record.now = NOW + PROPOSAL_TTL_MS + 1;
    expect((await body(await send(click(`add:confirm:${id}`)))).data).toEqual({
      content: EXPIRED,
      components: [],
      allowed_mentions: { parse: [] },
    });
    expect(proposals.count()).toBe(0);
    expect((await body(await send(click(`add:cancel:${"A".repeat(22)}`)))).data.content).toBe(
      EXPIRED,
    );
    expect(engine.adds).toEqual([]);
  });

  it("passes on the engine's refusal at confirm (a folder gone, the quota), and hides its failures", async () => {
    const first = await proposed();
    first.engine.added = {
      refused: "Discord has added as much as it may today; try again tomorrow.",
    };
    expect((await body(await first.send(click(`add:confirm:${first.id}`)))).data.content).toBe(
      "Discord has added as much as it may today; try again tomorrow.",
    );
    expect(first.alarms.sets).toEqual([]);
    const second = await proposed();
    second.engine.broken = true;
    expect((await body(await second.send(click(`add:confirm:${second.id}`)))).data.content).toBe(
      ADD_FAILED,
    );
  });

  it("keeps the proposal sealed: no card, folder or summary in storage's clear", async () => {
    const { storage } = await proposed();
    const rows = storage.db.prepare("SELECT * FROM proposals").all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].discord_user_id).toBe(READER);
    const sealed = Buffer.from(rows[0].sealed as Uint8Array).toString("latin1");
    for (const word of ["Lightning", "Bolt", "bolt-2x2", "Added from Discord", "uid-added"]) {
      expect(sealed).not.toContain(word);
    }
  });

  it("is told the bot is not paired when it has since been unpaired", async () => {
    const { send, id, engine } = await proposed();
    engine.state = { ...PAIRED, paired: false };
    expect((await body(await send(click(`add:confirm:${id}`)))).data.content).toBe(NOT_PAIRED);
    expect(engine.adds).toEqual([]);
  });
});

describe("a button's custom id", () => {
  it("is add:confirm:<id> or add:cancel:<id>, with a 22-character id", () => {
    const id = "abcdefghijklmnopqrstuv";
    expect(pressed(`add:confirm:${id}`)).toEqual({ confirm: true, id });
    expect(pressed(`add:cancel:${id}`)).toEqual({ confirm: false, id });
    for (const other of [`add:confirm:${id}x`, `add:undo:${id}`, "deck:1", 7, null]) {
      expect(pressed(other)).toBeNull();
    }
  });
});

describe("the folder's completion", () => {
  it("is the engine's user folders, for /collection add only", async () => {
    const { ask, engine } = await setUp();
    engine.folderChoices = [{ name: "Binder/Artifacts", value: "uid-1" }];
    const focused = (list: string) => ({
      type: 4,
      data: {
        name: list,
        options: [
          {
            type: 1,
            name: "add",
            options: [{ type: 3, name: "folder", value: "bin", focused: true }],
          },
        ],
      },
      user: { id: READER },
    });
    expect(await body(await ask(focused("collection")))).toEqual({
      type: 8,
      data: { choices: [{ name: "Binder/Artifacts", value: "uid-1" }] },
    });
    expect(await body(await ask(focused("wishlist")))).toEqual({ type: 8, data: { choices: [] } });
    expect(engine.calls).toEqual(["folders bin 25"]);
  });
});
