import { describe, expect, it } from "vitest";
import { sweepLapsed } from "../src/lapse";
import { importKek, openRow, rowKey, unwrapDataKey } from "../src/seal";
import {
  ALL_OFF,
  ALL_ON,
  digestOf,
  documentOf,
  gzip,
  harness,
  KEK,
  putSettings,
  putTable,
  request,
  token,
} from "./fake";

/**
 * The store's routes, end to end through the router and the door: settings make a store and
 * change its policy, a projection replaces a table (writing only the rows that changed, which
 * `object.test.ts` holds), the digests say what is held, and `DELETE` empties the object. Each
 * case reads the object's own SQLite afterwards, because "the route answered 200" and "the store
 * holds this" are two claims.
 */

const ENTRY = {
  uid: "e-1",
  scryfallId: "0000aaaa-0000-0000-0000-000000000001",
  name: "Lim-Dûl's Vault",
  set: "all",
  cn: "56",
  finish: "nonfoil",
  quantity: 2,
  folderUid: "f-1",
  image: "https://cards.scryfall.io/normal/front/0/0/x.jpg",
};

type H = ReturnType<typeof harness>;

/** The object's tables and rows, read past the store. */
function objectOf(h: H, group = "g1") {
  const db = h.stores.objectOf(group).storage.db;
  return {
    tables: () =>
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => row.name),
    rows: (table: string) => db.prepare("SELECT * FROM rows WHERE tbl = ? ORDER BY uid").all(table),
    meta: (key: string) =>
      db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value as string | undefined,
  };
}

const groupRows = (h: H) =>
  h.db.prepare("SELECT group_id FROM integration_groups ORDER BY group_id").all();

async function digests(h: H, group = "g1") {
  return h.fetch(request("GET", `/g/${group}/projection/digests`, { bearer: await token(group) }));
}

describe("a group with no store", () => {
  it("is off: its digests and its projections are 404 no_store, and nothing is written", async () => {
    const h = harness();
    const res = await digests(h);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "integrations are off for this group",
      code: "no_store",
    });
    const put = await putTable(
      h.fetch,
      "collection_entries",
      documentOf("collection_entries", [ENTRY]),
    );
    expect(put.status).toBe(404);
    expect(((await put.json()) as { code: string }).code).toBe("no_store");
    // Asked twice and written to by neither: no table, no row, no D1 row.
    expect(objectOf(h).tables()).toEqual([]);
    expect(groupRows(h)).toEqual([]);
  });
});

describe("PUT /g/{group}/settings", () => {
  it("makes the store, records the settings and the group's row, and says it made it", async () => {
    const h = harness();
    const res = await putSettings(h.fetch, { ...ALL_OFF, notes: true }, "g1", {
      marketplace: "cardmarket",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      fields: { ...ALL_OFF, notes: true },
      marketplace: "cardmarket",
      created: true,
    });
    expect(objectOf(h).tables()).toEqual(["meta", "rows", "tables"]);
    expect(groupRows(h)).toEqual([{ group_id: "g1" }]);

    const listed = await digests(h);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({
      fields: { ...ALL_OFF, notes: true },
      marketplace: "cardmarket",
      tables: {},
    });
  });

  it("keeps the data key wrapped, never in the clear, under the KEK and the group", async () => {
    const h = harness();
    await putSettings(h.fetch, ALL_ON);
    const wrapped = objectOf(h).meta("data_key")!;
    const kek = await importKek(KEK, "INTEGRATIONS_KEK");
    const key = await unwrapDataKey(kek, wrapped, "g1");
    expect(key).toHaveLength(32);
    // 12 bytes of nonce, 32 of key, 16 of tag: base64url of 60 bytes, and not the key's 43.
    expect(wrapped).toHaveLength(80);
  });

  it("answers the same settings again as already made, and changes nothing", async () => {
    const h = harness();
    await putSettings(h.fetch, ALL_ON);
    await putTable(
      h.fetch,
      "collection_entries",
      documentOf("collection_entries", [ENTRY], ["condition", "lang", "value", "tags", "notes"]),
    );
    const again = await putSettings(h.fetch, ALL_ON);
    expect(await again.json()).toEqual({
      fields: ALL_ON,
      marketplace: "tcgplayer",
      created: false,
    });
    expect(objectOf(h).rows("collection_entries")).toHaveLength(1);
    expect(groupRows(h)).toEqual([{ group_id: "g1" }]);
  });

  it("drops every table when the policy changes, so narrowing it takes the notes off at once", async () => {
    const h = harness();
    await putSettings(h.fetch, { ...ALL_OFF, notes: true });
    const noted = { ...ENTRY, notes: "the one I opened at the prerelease" };
    expect(
      (
        await putTable(
          h.fetch,
          "collection_entries",
          documentOf("collection_entries", [noted], ["notes"]),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await putTable(
          h.fetch,
          "decks",
          documentOf("decks", [{ uid: "d-1", name: "Burn" }], ["notes"]),
        )
      ).status,
    ).toBe(200);

    const narrowed = await putSettings(h.fetch, ALL_OFF);
    expect(await narrowed.json()).toEqual({
      fields: ALL_OFF,
      marketplace: "tcgplayer",
      created: false,
    });
    expect(objectOf(h).rows("collection_entries")).toEqual([]);
    expect(objectOf(h).rows("decks")).toEqual([]);
    expect(await (await digests(h)).json()).toEqual({
      fields: ALL_OFF,
      marketplace: "tcgplayer",
      tables: {},
    });
    // And a device still projecting under the old policy is told so, not stored.
    const late = await putTable(
      h.fetch,
      "collection_entries",
      documentOf("collection_entries", [noted], ["notes"]),
      { ms: 9_999 },
    );
    expect(late.status).toBe(409);
    expect(await late.json()).toEqual({
      error: "that projection was made under other settings than the store's",
      code: "settings_mismatch",
      fields: ALL_OFF,
      marketplace: "tcgplayer",
    });
  });

  /**
   * The marketplace is the group's, as the fields are: two devices pricing one table from two
   * marketplaces would overwrite each other on every publish. A new one drops every table, so no
   * price from the old marketplace is left beside the new.
   */
  it("drops every table when the marketplace changes, and refuses a document priced the old way", async () => {
    const h = harness();
    await putSettings(h.fetch, { ...ALL_OFF, value: true });
    const priced = { ...ENTRY, value: 1.5 };
    expect(
      (
        await putTable(
          h.fetch,
          "collection_entries",
          documentOf("collection_entries", [priced], ["value"]),
        )
      ).status,
    ).toBe(200);

    const moved = await putSettings(h.fetch, { ...ALL_OFF, value: true }, "g1", {
      marketplace: "cardmarket",
    });
    expect(await moved.json()).toEqual({
      fields: { ...ALL_OFF, value: true },
      marketplace: "cardmarket",
      created: false,
    });
    expect(objectOf(h).rows("collection_entries")).toEqual([]);
    expect(await (await digests(h)).json()).toEqual({
      fields: { ...ALL_OFF, value: true },
      marketplace: "cardmarket",
      tables: {},
    });

    const late = await putTable(
      h.fetch,
      "collection_entries",
      documentOf("collection_entries", [priced], ["value"]),
      { ms: 9_999 },
    );
    expect(late.status).toBe(409);
    expect(await late.json()).toEqual({
      error: "that projection was made under other settings than the store's",
      code: "settings_mismatch",
      fields: { ...ALL_OFF, value: true },
      marketplace: "cardmarket",
    });
    const right = await putTable(
      h.fetch,
      "collection_entries",
      documentOf("collection_entries", [priced], ["value"], "cardmarket"),
      { ms: 9_999 },
    );
    expect(right.status).toBe(200);
  });

  /**
   * A change of settings from a device that has not heard of another's switch-off: it must not
   * bring the store back. `create: false` on a group with no store makes nothing — not the
   * object, not the row — and says the store is off.
   */
  it("makes nothing with create: false on a group with no store, and answers no_store", async () => {
    const h = harness();
    const res = await putSettings(h.fetch, ALL_ON, "g1", { create: false });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "integrations are off for this group",
      code: "no_store",
    });
    expect(objectOf(h).tables()).toEqual([]);
    expect(groupRows(h)).toEqual([]);

    // After a switch-off, too: the store stays gone.
    await putSettings(h.fetch, ALL_OFF);
    await h.fetch(request("DELETE", "/g/g1", { bearer: await token() }));
    expect((await putSettings(h.fetch, ALL_ON, "g1", { create: false })).status).toBe(404);
    expect(objectOf(h).tables()).toEqual([]);
    expect(groupRows(h)).toEqual([]);
  });

  it("changes the settings of a store that exists with create: false", async () => {
    const h = harness();
    await putSettings(h.fetch, ALL_OFF);
    const res = await putSettings(h.fetch, ALL_ON, "g1", {
      marketplace: "manapool",
      create: false,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ fields: ALL_ON, marketplace: "manapool", created: false });
  });

  const body = (value: Record<string, unknown>) => JSON.stringify(value);
  const SETTINGS = { fields: ALL_OFF, marketplace: "tcgplayer", create: true };

  it.each([
    ["no body", undefined],
    ["not JSON", "{"],
    ["nothing in it", body({})],
    ["no fields", body({ marketplace: "tcgplayer", create: true })],
    [
      "a field missing",
      body({ ...SETTINGS, fields: { condition: true, lang: true, value: true, tags: true } }),
    ],
    ["an unknown field", body({ ...SETTINGS, fields: { ...ALL_OFF, price: true } })],
    ["a field that is not a boolean", body({ ...SETTINGS, fields: { ...ALL_OFF, notes: "yes" } })],
    ["fields as a list", body({ ...SETTINGS, fields: ["notes"] })],
    ["no marketplace", body({ fields: ALL_OFF, create: true })],
    ["a marketplace nobody prices from", body({ ...SETTINGS, marketplace: "cardtrader" })],
    ["a marketplace in another case", body({ ...SETTINGS, marketplace: "TCGplayer" })],
    ["no create", body({ fields: ALL_OFF, marketplace: "tcgplayer" })],
    ["a create that is not a boolean", body({ ...SETTINGS, create: "yes" })],
    ["a key too many", body({ ...SETTINGS, currency: "USD" })],
    ["too long", body({ ...SETTINGS, pad: "x".repeat(5000) })],
  ])("refuses a body with %s as 400 bad_settings, and makes no store", async (_case, sent) => {
    const h = harness();
    const res = await h.fetch(
      request("PUT", "/g/g1/settings", { bearer: await token(), body: sent }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("bad_settings");
    expect(objectOf(h).tables()).toEqual([]);
    expect(groupRows(h)).toEqual([]);
  });

  it.each(["tcgplayer", "cardmarket", "cardkingdom", "manapool"])(
    "takes %s, one of the projection's four marketplaces",
    async (marketplace) => {
      const h = harness();
      const res = await putSettings(h.fetch, ALL_OFF, "g1", { marketplace });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { marketplace: string }).marketplace).toBe(marketplace);
    },
  );
});

describe("PUT /g/{group}/projection/{table}", () => {
  it("stores the table, answers what it holds, and lists it in the digests", async () => {
    const h = harness();
    await putSettings(h.fetch, ALL_OFF);
    const before = Date.now();
    const res = await putTable(
      h.fetch,
      "collection_entries",
      documentOf("collection_entries", [ENTRY]),
      {
        ms: 1_760_000_000_000,
        ctr: 3,
        digest: digestOf(42),
      },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      table: "collection_entries",
      digest: digestOf(42),
      rows: 1,
      hlcMs: 1_760_000_000_000,
      hlcCtr: 3,
    });
    const listed = (await (await digests(h)).json()) as {
      tables: Record<string, { publishedAt: number }>;
    };
    expect(listed.tables).toEqual({
      collection_entries: {
        digest: digestOf(42),
        hlcMs: 1_760_000_000_000,
        hlcCtr: 3,
        rows: 1,
        publishedAt: expect.any(Number),
      },
    });
    expect(listed.tables.collection_entries.publishedAt).toBeGreaterThanOrEqual(before);
  });

  it("keeps only the index columns in the clear, and the row whole and sealed", async () => {
    const h = harness();
    await putSettings(h.fetch, { ...ALL_OFF, notes: true });
    const noted = { ...ENTRY, notes: "a secret about the binder" };
    await putTable(
      h.fetch,
      "collection_entries",
      documentOf("collection_entries", [noted], ["notes"]),
    );

    const [row] = objectOf(h).rows("collection_entries") as Record<string, unknown>[];
    expect(Object.keys(row).sort()).toEqual(
      [
        "tbl",
        "uid",
        "scryfall_id",
        "name_norm",
        "set_code",
        "cn",
        "finish",
        "quantity",
        "folder_uid",
        "kind",
        "gen",
        "mac",
        "sealed",
      ].sort(),
    );
    expect({ ...row, mac: undefined, sealed: undefined }).toEqual({
      tbl: "collection_entries",
      uid: "e-1",
      scryfall_id: ENTRY.scryfallId,
      name_norm: "lim-dul's vault",
      set_code: "all",
      cn: "56",
      finish: "nonfoil",
      quantity: 2,
      folder_uid: "f-1",
      kind: null,
      gen: 1,
      mac: undefined,
      sealed: undefined,
    });
    expect(row.mac).toHaveLength(32);
    // ⚠️ The note is in the sealed body, and the stored bytes do not hold its text.
    const sealed = row.sealed as Uint8Array;
    expect(new TextDecoder("latin1").decode(sealed)).not.toContain("secret about the binder");
    expect(new TextDecoder("latin1").decode(sealed)).not.toContain("Vault");

    // And it opens, under the KEK's data key and its table generation's key, as the row sent.
    const dataKey = await unwrapDataKey(
      await importKek(KEK, "INTEGRATIONS_KEK"),
      objectOf(h).meta("data_key")!,
      "g1",
    );
    const key = await rowKey(dataKey, "collection_entries", Number(row.gen));
    expect(await openRow(key, "collection_entries", "e-1", sealed)).toEqual(noted);
  });

  it("keeps each table's container in folder_uid, whichever key names it", async () => {
    const h = harness();
    await putSettings(h.fetch, ALL_OFF);
    await putTable(
      h.fetch,
      "collection_folders",
      documentOf("collection_folders", [
        { uid: "f-2", name: "Trade binder", parentUid: "f-1", kind: "binder", locked: false },
      ]),
    );
    await putTable(
      h.fetch,
      "deck_cards",
      documentOf("deck_cards", [
        {
          uid: "c-1",
          deckUid: "d-1",
          pile: "Main",
          kind: "main",
          active: true,
          name: "Shock",
          quantity: 4,
        },
      ]),
    );
    const folder = objectOf(h).rows("collection_folders")[0];
    expect([folder.folder_uid, folder.kind, folder.name_norm]).toEqual([
      "f-1",
      "binder",
      "trade binder",
    ]);
    const card = objectOf(h).rows("deck_cards")[0];
    expect([card.folder_uid, card.kind, card.quantity]).toEqual(["d-1", "main", 4]);
  });

  it("replaces the table: a row the new document lacks is gone", async () => {
    const h = harness();
    await putSettings(h.fetch, ALL_OFF);
    const second = { ...ENTRY, uid: "e-2", name: "Shock" };
    await putTable(
      h.fetch,
      "collection_entries",
      documentOf("collection_entries", [ENTRY, second]),
    );
    expect(objectOf(h).rows("collection_entries")).toHaveLength(2);
    const res = await putTable(
      h.fetch,
      "collection_entries",
      documentOf("collection_entries", [second]),
      { ms: 2_000, digest: digestOf(2) },
    );
    expect(res.status).toBe(200);
    expect(
      objectOf(h)
        .rows("collection_entries")
        .map((row) => row.uid),
    ).toEqual(["e-2"]);
    // Another table is untouched by it.
    await putTable(h.fetch, "decks", documentOf("decks", [{ uid: "d-1", name: "Burn" }]));
    await putTable(h.fetch, "collection_entries", documentOf("collection_entries", []), {
      ms: 3_000,
    });
    expect(objectOf(h).rows("collection_entries")).toEqual([]);
    expect(objectOf(h).rows("decks")).toHaveLength(1);
  });

  it("refuses an older watermark than the table holds, with the one it holds", async () => {
    const h = harness();
    await putSettings(h.fetch, ALL_OFF);
    const doc = documentOf("collection_entries", [ENTRY]);
    expect((await putTable(h.fetch, "collection_entries", doc, { ms: 5_000, ctr: 2 })).status).toBe(
      200,
    );

    for (const [ms, ctr] of [
      [4_999, 9],
      [5_000, 1],
    ]) {
      const res = await putTable(
        h.fetch,
        "collection_entries",
        documentOf("collection_entries", []),
        {
          ms,
          ctr,
        },
      );
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: "a newer projection of that table is already stored",
        code: "stale_projection",
        hlcMs: 5_000,
        hlcCtr: 2,
      });
    }
    expect(objectOf(h).rows("collection_entries")).toHaveLength(1);
  });

  it("accepts an equal watermark — a republish after a price change moves no clock — and a newer one", async () => {
    const h = harness();
    await putSettings(h.fetch, ALL_OFF);
    const doc = documentOf("collection_entries", [ENTRY]);
    await putTable(h.fetch, "collection_entries", doc, { ms: 5_000, ctr: 2, digest: digestOf(1) });
    const equal = await putTable(h.fetch, "collection_entries", doc, {
      ms: 5_000,
      ctr: 2,
      digest: digestOf(2),
    });
    expect(equal.status).toBe(200);
    expect(((await equal.json()) as { digest: string }).digest).toBe(digestOf(2));
    expect((await putTable(h.fetch, "collection_entries", doc, { ms: 5_000, ctr: 3 })).status).toBe(
      200,
    );
    expect((await putTable(h.fetch, "collection_entries", doc, { ms: 5_001, ctr: 0 })).status).toBe(
      200,
    );
    // A watermark is a table's own: another table starts from nothing.
    expect(
      (await putTable(h.fetch, "decks", documentOf("decks", []), { ms: 1, ctr: 0 })).status,
    ).toBe(200);
  });

  it("refuses a document whose fields are not the store's as settings_mismatch, with the store's", async () => {
    const h = harness();
    await putSettings(h.fetch, { ...ALL_OFF, lang: true });
    for (const fields of [[], ["lang", "notes"], ["condition"]]) {
      const res = await putTable(
        h.fetch,
        "collection_entries",
        documentOf("collection_entries", [], fields),
      );
      expect(res.status, fields.join()).toBe(409);
      expect(await res.json()).toEqual({
        error: "that projection was made under other settings than the store's",
        code: "settings_mismatch",
        fields: { ...ALL_OFF, lang: true },
        marketplace: "tcgplayer",
      });
    }
    const right = await putTable(
      h.fetch,
      "collection_entries",
      documentOf("collection_entries", [], ["lang"]),
    );
    expect(right.status).toBe(200);
  });

  it("refuses a document priced from another marketplace than the store's, with the store's", async () => {
    const h = harness();
    await putSettings(h.fetch, { ...ALL_OFF, value: true }, "g1", { marketplace: "cardkingdom" });
    for (const marketplace of ["tcgplayer", "cardmarket", "manapool"]) {
      const res = await putTable(
        h.fetch,
        "collection_entries",
        documentOf("collection_entries", [], ["value"], marketplace),
      );
      expect(res.status, marketplace).toBe(409);
      expect(await res.json()).toEqual({
        error: "that projection was made under other settings than the store's",
        code: "settings_mismatch",
        fields: { ...ALL_OFF, value: true },
        marketplace: "cardkingdom",
      });
    }
    const right = await putTable(
      h.fetch,
      "collection_entries",
      documentOf("collection_entries", [], ["value"], "cardkingdom"),
    );
    expect(right.status).toBe(200);
  });

  const EVERY = ["condition", "lang", "value", "tags", "notes"];

  it.each([
    // Absent from the format, never a switch: refused under every field on.
    ["a key the format leaves out", "collection_entries", { ...ENTRY, purchasePrice: 3 }, true],
    [
      "an opt-in key its table never carries",
      "wishlist_entries",
      { ...ENTRY, condition: "NM" },
      true,
    ],
    ["a deck's description", "decks", { uid: "d-1", name: "Burn", description: "fast" }, true],
    // An opt-in key the document's policy did not switch on.
    ["an opt-in key whose field is off", "collection_entries", { ...ENTRY, notes: "n" }, false],
    ["a wish's entry tags with tags off", "wishlist_entries", { ...ENTRY, tags: ["cube"] }, false],
    ["no uid", "decks", { name: "Burn" }, true],
    ["an empty uid", "decks", { uid: "", name: "Burn" }, true],
    ["a uid that is not a string", "decks", { uid: 7, name: "Burn" }, true],
    ["a row that is not an object", "decks", ["d-1"], true],
  ])("refuses a row with %s as 400 bad_projection", async (_case, table, row, everyField) => {
    const h = harness();
    await putSettings(h.fetch, everyField ? ALL_ON : ALL_OFF);
    const res = await putTable(h.fetch, table, documentOf(table, [row], everyField ? EVERY : []));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("bad_projection");
    expect(objectOf(h).rows(table)).toEqual([]);
  });

  it("takes every opt-in key its table carries, once its field is on", async () => {
    const h = harness();
    await putSettings(h.fetch, ALL_ON);
    const full = { ...ENTRY, condition: "NM", lang: "en", value: 1.5, tags: ["trade"], notes: "n" };
    const res = await putTable(
      h.fetch,
      "collection_entries",
      documentOf("collection_entries", [full], EVERY),
    );
    expect(res.status).toBe(200);
  });

  it("takes a wish's entry tags once tags is on — the twin of a copy's (issue #1398)", async () => {
    const h = harness();
    await putSettings(h.fetch, ALL_ON);
    const wish = { ...ENTRY, oracleId: null, lang: "en", value: 1.5, tags: ["cube"], notes: "n" };
    const res = await putTable(
      h.fetch,
      "wishlist_entries",
      documentOf("wishlist_entries", [wish], EVERY),
    );
    expect(res.status).toBe(200);
    expect(objectOf(h).rows("wishlist_entries")).toHaveLength(1);
  });

  it.each([
    ["version 2", { ...documentOf("decks", []), v: 2 }],
    ["another table's name", documentOf("collection_entries", [])],
    ["fields out of their order", documentOf("decks", [], ["notes", "condition"])],
    ["a field it does not know", documentOf("decks", [], ["price"])],
    ["fields that are not a list", { ...documentOf("decks", []), fields: "notes" }],
    ["rows that are not a list", { ...documentOf("decks", []), rows: {} }],
    ["a uid twice", documentOf("decks", [{ uid: "d-1" }, { uid: "d-1" }])],
    ["a list for a document", []],
    ["a marketplace nobody prices from", { ...documentOf("decks", []), marketplace: "cardtrader" }],
    ["no marketplace", { ...documentOf("decks", []), marketplace: undefined }],
    ["dollars from Cardmarket", { ...documentOf("decks", [], [], "cardmarket"), currency: "USD" }],
    ["euros from TCGplayer", { ...documentOf("decks", []), currency: "EUR" }],
    ["no currency", { ...documentOf("decks", []), currency: undefined }],
  ])("refuses a document with %s as 400 bad_projection", async (_case, doc) => {
    const h = harness();
    await putSettings(h.fetch, ALL_ON);
    const res = await putTable(h.fetch, "decks", doc);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("bad_projection");
  });

  it("refuses a body that is not gzip, is cut short, or holds no JSON", async () => {
    const h = harness();
    await putSettings(h.fetch, ALL_OFF);
    const whole = await gzip(JSON.stringify(documentOf("decks", [])));
    for (const raw of [
      new TextEncoder().encode(JSON.stringify(documentOf("decks", []))),
      whole.slice(0, whole.length - 6),
      await gzip("not json"),
      new Uint8Array([0x1f]),
    ]) {
      const res = await putTable(h.fetch, "decks", null, { raw });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe("bad_projection");
    }
    expect(objectOf(h).rows("decks")).toEqual([]);
  });

  it.each([
    ["no watermark", { "x-projection-digest": digestOf(1) }],
    [
      "a watermark that is not digits",
      {
        "x-projection-hlc-ms": "1e3",
        "x-projection-hlc-ctr": "0",
        "x-projection-digest": digestOf(1),
      },
    ],
    [
      "a negative counter",
      {
        "x-projection-hlc-ms": "1",
        "x-projection-hlc-ctr": "-1",
        "x-projection-digest": digestOf(1),
      },
    ],
    [
      "a watermark past a safe integer",
      {
        "x-projection-hlc-ms": "9007199254740993",
        "x-projection-hlc-ctr": "0",
        "x-projection-digest": digestOf(1),
      },
    ],
    ["no digest", { "x-projection-hlc-ms": "1", "x-projection-hlc-ctr": "0" }],
    [
      "a digest in upper case",
      {
        "x-projection-hlc-ms": "1",
        "x-projection-hlc-ctr": "0",
        "x-projection-digest": digestOf(1).toUpperCase().replace(/^0/, "A"),
      },
    ],
    [
      "a short digest",
      { "x-projection-hlc-ms": "1", "x-projection-hlc-ctr": "0", "x-projection-digest": "ab" },
    ],
  ])("refuses %s as 400 bad_projection, before the store is asked", async (_case, headers) => {
    const h = harness();
    const res = await h.fetch(
      request("PUT", "/g/g1/projection/decks", {
        bearer: await token(),
        headers,
        body: await gzip(JSON.stringify(documentOf("decks", []))),
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("bad_projection");
    // No settings were ever put, so a store asked would have said no_store: it was not asked.
    expect(h.stores.objects.size).toBe(0);
  });

  it("refuses more than eight megabytes as sent, counted, before the store is asked", async () => {
    const h = harness();
    await putSettings(h.fetch, ALL_OFF);
    const objects = h.stores.objects.size;
    const raw = new Uint8Array(8 * 1024 * 1024 + 1);
    raw.set([0x1f, 0x8b]);
    const res = await putTable(h.fetch, "decks", null, { raw });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: `that projection is ${8 * 1024 * 1024 + 1} bytes gzipped and a table may be at most ${8 * 1024 * 1024}`,
      code: "projection_limit",
    });
    expect(h.stores.objects.size).toBe(objects);
    expect(objectOf(h).rows("decks")).toEqual([]);
  });

  it("refuses a declared size past eight megabytes without reading the body", async () => {
    const h = harness();
    await putSettings(h.fetch, ALL_OFF);
    let pulled = 0;
    // Finite, so a router that read it anyway answers something to fail on rather than spinning
    // on an endless stream: its microtasks would starve the suite's own timeout.
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 64) controller.close();
        else controller.enqueue(new Uint8Array(1024));
      },
    });
    const req = new Request("https://integrations.example/g/g1/projection/decks", {
      method: "PUT",
      headers: {
        authorization: `Bearer ${await token()}`,
        "content-length": String(9 * 1024 * 1024),
        "x-projection-hlc-ms": "1",
        "x-projection-hlc-ctr": "0",
        "x-projection-digest": digestOf(1),
      },
      body,
      duplex: "half",
    } as RequestInit);
    const res = await h.fetch(req);
    expect(res.status).toBe(413);
    expect(((await res.json()) as { code: string }).code).toBe("projection_limit");
    // A stream starts one pull ahead of any reader; nothing read it past that.
    expect(pulled).toBeLessThanOrEqual(1);
  });

  /** A valid version-1 document, padded with whitespace to `size` bytes, gzipped. */
  async function paddedTo(size: number): Promise<Uint8Array> {
    const padded = new Uint8Array(size).fill(0x20);
    padded.set(new TextEncoder().encode(JSON.stringify(documentOf("decks", []))), 0);
    return gzip(padded);
  }

  it("refuses a document that inflates past twenty-four mebibytes — a gzip bomb — as 413", async () => {
    const h = harness();
    await putSettings(h.fetch, ALL_OFF);
    // Valid JSON all the way, one byte past the cap: only the cap refuses it.
    const raw = await paddedTo(24 * 1024 * 1024 + 1);
    expect(raw.length).toBeLessThan(1024 * 1024);
    const res = await putTable(h.fetch, "decks", null, { raw });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: "that projection inflates past 24 MiB",
      code: "projection_limit",
    });
  });

  it("takes a document of exactly twenty-four mebibytes inflated", async () => {
    const h = harness();
    await putSettings(h.fetch, ALL_OFF);
    const res = await putTable(h.fetch, "decks", null, { raw: await paddedTo(24 * 1024 * 1024) });
    expect(res.status).toBe(200);
  });

  it("refuses a body that inflates to something that is not UTF-8", async () => {
    const h = harness();
    await putSettings(h.fetch, ALL_OFF);
    const doc = new TextEncoder().encode(JSON.stringify(documentOf("decks", [{ uid: "d-1" }])));
    // `"d-1"` → `"d\xff1"`: a byte no UTF-8 sequence holds, inside a string.
    doc[doc.indexOf(0x2d)] = 0xff;
    const res = await putTable(h.fetch, "decks", null, { raw: await gzip(doc) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("bad_projection");
  });
});

describe("DELETE /g/{group}", () => {
  /** The issue's acceptance: switching off empties the object and forgets the group's row. */
  it("empties the object and deletes the group's row, and the store cannot be brought back by a PUT", async () => {
    const h = harness();
    await putSettings(h.fetch, ALL_ON);
    await putTable(
      h.fetch,
      "decks",
      documentOf(
        "decks",
        [{ uid: "d-1", name: "Burn" }],
        ["condition", "lang", "value", "tags", "notes"],
      ),
    );
    expect(objectOf(h).rows("decks")).toHaveLength(1);

    const res = await h.fetch(request("DELETE", "/g/g1", { bearer: await token() }));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(objectOf(h).tables()).toEqual([]);
    expect(groupRows(h)).toEqual([]);

    expect((await digests(h)).status).toBe(404);
    const late = await putTable(h.fetch, "decks", documentOf("decks", []), { ms: 99_999 });
    expect(late.status).toBe(404);
    expect(objectOf(h).tables()).toEqual([]);
  });

  it("answers 204 for a group that never had a store, and twice", async () => {
    const h = harness();
    for (let i = 0; i < 2; i += 1) {
      expect((await h.fetch(request("DELETE", "/g/g1", { bearer: await token() }))).status).toBe(
        204,
      );
    }
    expect(groupRows(h)).toEqual([]);
  });

  it("leaves another group's store alone", async () => {
    const h = harness();
    await putSettings(h.fetch, ALL_OFF, "g1");
    await putSettings(h.fetch, ALL_OFF, "g2");
    await h.fetch(request("DELETE", "/g/g1", { bearer: await token() }));
    expect(objectOf(h, "g2").tables()).toEqual(["meta", "rows", "tables"]);
    expect(groupRows(h)).toEqual([{ group_id: "g2" }]);
  });

  /**
   * The review's race (2026-10-25), with the network's timing forced: device B's settings reach
   * the object just after device A's `deleteAll`, and A's delete of the row reaches D1 just after
   * B's store is made. Without the re-check the store is left with no row, and no lapse pass
   * could ever empty it.
   */
  it("gives a store switched on again mid-switch-off its row back, where the lapse pass finds it", async () => {
    const h = harness();
    expect((await putSettings(h.fetch, ALL_OFF)).status).toBe(200);
    const store = h.stores.objectOf("g1").store;
    const settings = store.settings.bind(store);
    const deleteAll = store.deleteAll.bind(store);
    let deleted!: () => void;
    const afterDelete = new Promise<void>((resolve) => (deleted = resolve));
    let created!: () => void;
    const afterCreate = new Promise<void>((resolve) => (created = resolve));
    store.settings = async (...args: Parameters<typeof settings>) => {
      await afterDelete;
      const out = await settings(...args);
      created();
      return out;
    };
    store.deleteAll = async () => {
      await deleteAll();
      deleted();
      await afterCreate;
    };

    const [on, off] = await Promise.all([
      putSettings(h.fetch, ALL_ON),
      h.fetch(request("DELETE", "/g/g1", { bearer: await token() })),
    ]);
    expect([on.status, off.status]).toEqual([200, 204]);
    expect(((await on.json()) as { created: boolean }).created).toBe(true);
    expect(objectOf(h).tables()).toEqual(["meta", "rows", "tables"]);
    expect(groupRows(h)).toEqual([{ group_id: "g1" }]);

    // And so the store is the lapse pass's to empty, once the membership ends.
    store.settings = settings;
    store.deleteAll = deleteAll;
    h.db.prepare("UPDATE entitlements SET status = 'dead' WHERE group_id = 'g1'").run();
    expect(await sweepLapsed(h.env, Date.now())).toEqual(["g1"]);
    expect(objectOf(h).tables()).toEqual([]);
    expect(groupRows(h)).toEqual([]);
  });
});
