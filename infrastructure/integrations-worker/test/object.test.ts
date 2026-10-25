import { describe, expect, it, vi } from "vitest";
import { CLEAR_COLUMNS_VERSION } from "../src/projection";
import {
  canonical,
  importKek,
  kekFingerprint,
  macKey,
  openRow,
  rowKey,
  rowMac,
  unwrapDataKey,
} from "../src/seal";
import { Store } from "../src/store";
import { ALL_OFF, digestOf, documentOf, gzip, KEK, NEXT_KEK, sqlStorage } from "./fake";

/**
 * A group's `Store` driven directly, for what the router cannot show: two requests interleaved
 * inside one object while one of them awaits its sealing, and the KEK moving under a store.
 *
 * **Workers RPC does not serialise an object's requests.** While a replacement awaits WebCrypto,
 * another request to the same object can run — so every decision the first look made is made
 * again inside the transaction that writes, and these cases are what hold `store.ts` to that.
 */

const DECK = (uid: string) => ({ uid, name: `Deck ${uid}` });

async function made(
  env = { INTEGRATIONS_KEK: KEK } as {
    INTEGRATIONS_KEK: string;
    INTEGRATIONS_KEK_PREVIOUS?: string;
  },
) {
  const storage = sqlStorage();
  const store = new Store(storage, env);
  await store.settings("g1", { fields: ALL_OFF, marketplace: "tcgplayer" }, true, 1);
  return { storage, store, env };
}

const gz = (rows: object[]) => gzip(JSON.stringify(documentOf("decks", rows)));

/** A watermark at `ms`. */
const at = (ms: number) => ({ ms, ctr: 0 });

type Storage = ReturnType<typeof sqlStorage>;

/** The store's data key, opened the way the store opens it. */
async function dataKeyOf(storage: Storage, kek = KEK): Promise<Uint8Array> {
  return unwrapDataKey(
    await importKek(kek, "INTEGRATIONS_KEK"),
    String(storage.db.prepare("SELECT value FROM meta WHERE key = 'data_key'").get()?.value),
    "g1",
  );
}

/** Every stored row of `decks`: its generation, MAC and sealed body. */
function heldRows(storage: Storage) {
  return Object.fromEntries(
    storage.db
      .prepare("SELECT uid, gen, mac, sealed FROM rows WHERE tbl = 'decks' ORDER BY uid")
      .all()
      .map((row) => [
        String(row.uid),
        { gen: Number(row.gen), mac: row.mac as Uint8Array, sealed: row.sealed as Uint8Array },
      ]),
  );
}

/** Every stored row of `decks`, opened under the key of the generation it records. */
async function openAll(storage: Storage, kek = KEK): Promise<Record<string, unknown>> {
  const dataKey = await dataKeyOf(storage, kek);
  const out: Record<string, unknown> = {};
  for (const [uid, row] of Object.entries(heldRows(storage))) {
    out[uid] = await openRow(await rowKey(dataKey, "decks", row.gen), "decks", uid, row.sealed);
  }
  return out;
}

/** Rows written since `before`, by table — the fake counts them as the platform bills them. */
function writtenSince(storage: Storage, before: Record<string, number>) {
  const out: Record<string, number> = {};
  for (const [table, n] of Object.entries(storage.written)) {
    if (n !== (before[table] ?? 0)) out[table] = n - (before[table] ?? 0);
  }
  return out;
}

/**
 * **A replacement writes only what changed** — the device still sends its table whole. Each case
 * reads the rows written off the fake (a delete counts, as Cloudflare counts it) and the stored
 * generation, MAC and sealed bytes of every row: a row left alone is the same bytes as before.
 */
describe("a replacement", () => {
  const THREE = [DECK("a"), DECK("b"), DECK("c")];

  it("writes every row of a first publish, and the table's row", async () => {
    const { storage, store } = await made();
    const before = { ...storage.written };
    expect(
      (await store.replace("g1", "decks", await gz(THREE), at(1), digestOf(1), 1)).status,
    ).toBe(200);
    // Three rows, the table's row, and the generation it took.
    expect(writtenSince(storage, before)).toEqual({ rows: 3, tables: 1, meta: 1 });
    expect(Object.values(heldRows(storage)).map((row) => row.gen)).toEqual([1, 1, 1]);
  });

  it("writes no row and seals nothing when the table is republished unchanged", async () => {
    const { storage, store } = await made();
    await store.replace("g1", "decks", await gz(THREE), at(1), digestOf(1), 1);
    const held = heldRows(storage);
    const before = { ...storage.written };

    // The same rows, a later clock, a new digest — and the keys of one row in another order.
    const reordered = [DECK("a"), { name: "Deck b", uid: "b" }, DECK("c")];
    const answer = await store.replace("g1", "decks", await gz(reordered), at(2), digestOf(2), 2);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      table: "decks",
      digest: digestOf(2),
      rows: 3,
      hlcMs: 2,
      hlcCtr: 0,
    });
    // The table's row moves (its digest and watermark), and nothing else: no row, no generation.
    expect(writtenSince(storage, before)).toEqual({ tables: 1 });
    expect(heldRows(storage)).toEqual(held);
    expect((await store.digests("g1"))?.tables.decks).toMatchObject({
      digest: digestOf(2),
      rows: 3,
    });
  });

  it("seals exactly the one row that changed, in a generation of its own", async () => {
    const { storage, store } = await made();
    await store.replace("g1", "decks", await gz(THREE), at(1), digestOf(1), 1);
    const held = heldRows(storage);
    const before = { ...storage.written };

    const changed = [DECK("a"), { uid: "b", name: "Deck b, renamed" }, DECK("c")];
    expect(
      (await store.replace("g1", "decks", await gz(changed), at(2), digestOf(2), 2)).status,
    ).toBe(200);
    expect(writtenSince(storage, before)).toEqual({ rows: 1, tables: 1, meta: 1 });
    const now = heldRows(storage);
    expect(now.a).toEqual(held.a);
    expect(now.c).toEqual(held.c);
    expect(now.b.gen).toBe(2);
    expect(now.b.sealed).not.toEqual(held.b.sealed);
    expect(now.b.mac).not.toEqual(held.b.mac);
    expect(Number(storage.db.prepare("SELECT generation FROM tables").get()?.generation)).toBe(2);
  });

  it("deletes a row whose uid the document no longer carries, and writes nothing else", async () => {
    const { storage, store } = await made();
    await store.replace("g1", "decks", await gz(THREE), at(1), digestOf(1), 1);
    const held = heldRows(storage);
    const before = { ...storage.written };
    await store.replace("g1", "decks", await gz([DECK("a"), DECK("c")]), at(2), digestOf(2), 2);
    expect(writtenSince(storage, before)).toEqual({ rows: 1, tables: 1 });
    expect(heldRows(storage)).toEqual({ a: held.a, c: held.c });
    expect((await store.digests("g1"))?.tables.decks?.rows).toBe(2);
  });

  it("keeps rows of two generations, and each opens under its own generation's key only", async () => {
    const { storage, store } = await made();
    await store.replace("g1", "decks", await gz(THREE), at(1), digestOf(1), 1);
    const changed = [DECK("a"), { uid: "b", name: "Deck b, renamed" }, DECK("c"), DECK("d")];
    await store.replace("g1", "decks", await gz(changed), at(2), digestOf(2), 2);

    const held = heldRows(storage);
    expect(Object.fromEntries(Object.entries(held).map(([uid, row]) => [uid, row.gen]))).toEqual({
      a: 1,
      b: 2,
      c: 1,
      d: 2,
    });
    expect(await openAll(storage)).toEqual({
      a: DECK("a"),
      b: changed[1],
      c: DECK("c"),
      d: DECK("d"),
    });
    const dataKey = await dataKeyOf(storage);
    await expect(
      openRow(await rowKey(dataKey, "decks", 2), "decks", "a", held.a.sealed),
    ).rejects.toThrow();
    await expect(
      openRow(await rowKey(dataKey, "decks", 1), "decks", "b", held.b.sealed),
    ).rejects.toThrow();
  });

  it("keys its MAC: it is no unkeyed SHA-256 of the row, and is the HMAC under the store's MAC key", async () => {
    const { storage, store } = await made();
    await store.replace("g1", "decks", await gz([DECK("a")]), at(1), digestOf(1), 1);
    const { mac } = heldRows(storage).a;
    const encoder = new TextEncoder();
    const sha = async (text: string) =>
      new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
    expect(mac).toHaveLength(32);
    for (const text of [
      `decks\u0000${canonical(DECK("a"))}`,
      canonical(DECK("a")),
      JSON.stringify(DECK("a")),
    ]) {
      expect(mac).not.toEqual(await sha(text));
    }
    const key = await macKey(await dataKeyOf(storage));
    expect(await rowMac(key, "decks", DECK("a"))).toEqual(new Uint8Array(mac));
    // Over the table, the clear columns' version and the canonical row — the version, so that a
    // change to how a clear column is derived moves every MAC and rewrites every row.
    const signed = async (version: number) =>
      new Uint8Array(
        await crypto.subtle.sign(
          "HMAC",
          key,
          encoder.encode(`decks\u0000${version}\u0000${canonical(DECK("a"))}`),
        ),
      );
    expect(new Uint8Array(mac)).toEqual(await signed(CLEAR_COLUMNS_VERSION));
    expect(new Uint8Array(mac)).not.toEqual(await signed(CLEAR_COLUMNS_VERSION + 1));
    // And another store's key gives another MAC for the same row.
    const other = await made();
    await other.store.replace("g1", "decks", await gz([DECK("a")]), at(1), digestOf(1), 1);
    expect(heldRows(other.storage).a.mac).not.toEqual(mac);
  });

  it("seals the whole table again after a change of policy", async () => {
    const { storage, store } = await made();
    await store.replace("g1", "decks", await gz(THREE), at(1), digestOf(1), 1);
    await store.settings(
      "g1",
      { fields: { ...ALL_OFF, lang: true }, marketplace: "tcgplayer" },
      true,
      2,
    );
    const before = { ...storage.written };
    const doc = gzip(JSON.stringify(documentOf("decks", THREE, ["lang"])));
    expect((await store.replace("g1", "decks", await doc, at(1), digestOf(1), 3)).status).toBe(200);
    expect(writtenSince(storage, before)).toEqual({ rows: 3, tables: 1, meta: 1 });
  });
});

describe("two requests in one object", () => {
  it("lets a switch-off that lands mid-replacement win: nothing is written back", async () => {
    const { storage, store } = await made();
    const pending = store.replace(
      "g1",
      "decks",
      await gz([DECK("d-1")]),
      { ms: 1, ctr: 0 },
      digestOf(1),
      2,
    );
    await store.deleteAll();
    expect((await pending).status).toBe(404);
    expect(storage.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual(
      [],
    );
  });

  it("lets a switch-off that lands while the rows are being sealed win, too", async () => {
    const { storage, store } = await made();
    // The replacement's first transaction is its first round, which finds the row to seal: the
    // switch-off lands at the first await after it commits — while that row is being sealed — as
    // another request to the object would, since nothing runs between two awaits but the
    // request that holds them.
    const transaction = storage.transactionSync.bind(storage);
    let switchedOff: Promise<void> | undefined;
    storage.transactionSync = <T>(closure: () => T): T => {
      const out = transaction(closure);
      if (switchedOff === undefined) {
        switchedOff = Promise.resolve().then(() => store.deleteAll());
      }
      return out;
    };
    const answer = await store.replace(
      "g1",
      "decks",
      await gz([DECK("d-1")]),
      { ms: 1, ctr: 0 },
      digestOf(1),
      2,
    );
    await switchedOff;
    expect(answer.status).toBe(404);
    expect(storage.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual(
      [],
    );
  });

  it.each([
    ["a field policy", { fields: { ...ALL_OFF, notes: true }, marketplace: "tcgplayer" as const }],
    ["a marketplace", { fields: ALL_OFF, marketplace: "cardmarket" as const }],
  ])(
    "lets a change of %s that lands mid-replacement win: the document is refused",
    async (_what, wanted) => {
      const { storage, store } = await made();
      const pending = store.replace(
        "g1",
        "decks",
        await gz([DECK("d-1")]),
        { ms: 1, ctr: 0 },
        digestOf(1),
        2,
      );
      await store.settings("g1", wanted, true, 3);
      const answer = await pending;
      expect(answer.status).toBe(409);
      expect(answer.body).toMatchObject({ code: "settings_mismatch", ...wanted });
      expect(storage.db.prepare("SELECT count(*) AS n FROM rows").get()?.n).toBe(0);
    },
  );

  it("keeps the newer of two replacements, whichever finishes last", async () => {
    const { storage, store } = await made();
    const newer = store.replace(
      "g1",
      "decks",
      await gz([DECK("new")]),
      { ms: 9, ctr: 0 },
      digestOf(9),
      2,
    );
    const older = store.replace(
      "g1",
      "decks",
      await gz([DECK("old")]),
      { ms: 5, ctr: 0 },
      digestOf(5),
      3,
    );
    const answers = await Promise.all([newer, older]);
    expect(answers.map((a) => a.status).sort()).toEqual([200, 409]);
    expect(storage.db.prepare("SELECT uid FROM rows").all()).toEqual([{ uid: "new" }]);
    expect((await store.digests("g1"))?.tables.decks?.digest).toBe(digestOf(9));
  });

  /**
   * Another publish of the same table rewrites a row this one found unchanged, while this one is
   * sealing the rows it did find changed. Its transaction must not leave that row as the other
   * publish wrote it: it seals it too, in another round, and writes its own document whole.
   */
  it("seals, in another round, a row another publish changed under it", async () => {
    const { storage, store } = await made();
    await store.replace("g1", "decks", await gz([DECK("a"), DECK("b")]), at(1), digestOf(1), 1);
    const wanted = [{ uid: "a", name: "A, renamed" }, DECK("b")];

    // The replacement's second transaction takes its generation: the other publish lands then,
    // rewriting `b` — a direct write, as a committed transaction of another request would be.
    const transaction = storage.transactionSync.bind(storage);
    let calls = 0;
    storage.transactionSync = <T>(closure: () => T): T => {
      const out = transaction(closure);
      calls += 1;
      if (calls === 2) {
        storage.db
          .prepare("UPDATE rows SET mac = ?, sealed = ? WHERE uid = 'b'")
          .run(new Uint8Array(32), new Uint8Array(40));
      }
      return out;
    };
    const answer = await store.replace("g1", "decks", await gz(wanted), at(2), digestOf(2), 2);
    expect(answer.status).toBe(200);
    // Round one found `a`; round two found `b` changed under it; round three wrote both.
    expect(calls).toBe(4);
    const opened = await openAll(storage);
    expect(opened).toEqual({ a: wanted[0], b: wanted[1] });
  });

  /**
   * The review's case (2026-10-25): switched off and on again — same group, same policy — while a
   * replacement awaited its keys. The store that answers afterwards holds another data key, and
   * rows sealed under the old one would never open there, while the device, told 200, would
   * never send them again. The replacement holds itself to the store it began with.
   */
  it.each([
    ["while it MACs the rows", "row-mac"],
    ["while it seals them", "decks\u0000"],
  ])("answers 409 and writes nothing when the store is made again %s", async (_when, trigger) => {
    const { storage, store } = await made();
    const derive = crypto.subtle.deriveKey.bind(crypto.subtle);
    let fired = false;
    const spy = vi.spyOn(crypto.subtle, "deriveKey").mockImplementation((async (
      algorithm: { info?: ArrayBuffer | ArrayBufferView },
      ...rest: unknown[]
    ) => {
      const info = algorithm.info === undefined ? "" : new TextDecoder().decode(algorithm.info);
      if (!fired && info.startsWith(trigger)) {
        fired = true;
        await store.deleteAll();
        await store.settings("g1", { fields: ALL_OFF, marketplace: "tcgplayer" }, true, 2);
      }
      return (derive as (...args: unknown[]) => Promise<CryptoKey>)(algorithm, ...rest);
    }) as never);
    let answer;
    try {
      answer = await store.replace("g1", "decks", await gz([DECK("d-1")]), at(1), digestOf(1), 3);
    } finally {
      spy.mockRestore();
    }
    expect(fired).toBe(true);
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({ code: "stale_projection", hlcMs: 0, hlcCtr: 0 });
    expect(heldRows(storage)).toEqual({});
    expect((await store.digests("g1"))?.tables).toEqual({});

    // The device's next round finds the table missing and sends it, under the new store's key.
    expect(
      (await store.replace("g1", "decks", await gz([DECK("d-1")]), at(1), digestOf(1), 4)).status,
    ).toBe(200);
    expect(await openAll(storage)).toEqual({ "d-1": DECK("d-1") });
  });

  it("refuses to answer for another group than the one it was made for", async () => {
    const { store } = await made();
    await expect(store.digests("g2")).rejects.toThrow("this store belongs to another group");
  });
});

describe("rotating the KEK", () => {
  it("rewraps a store's data key on its next request, and the rows open under the new KEK", async () => {
    const { storage, store, env } = await made();
    await store.replace("g1", "decks", await gz([DECK("d-1")]), { ms: 1, ctr: 0 }, digestOf(1), 2);
    const before = String(
      storage.db.prepare("SELECT value FROM meta WHERE key = 'data_key'").get()?.value,
    );

    // The procedure: the old KEK becomes the previous one, a new KEK goes in.
    env.INTEGRATIONS_KEK_PREVIOUS = KEK;
    env.INTEGRATIONS_KEK = NEXT_KEK;
    expect((await store.digests("g1"))?.tables.decks?.rows).toBe(1);

    const meta = (key: string) =>
      String(storage.db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value);
    expect(meta("data_key")).not.toBe(before);
    expect(meta("kek")).toBe(await kekFingerprint(NEXT_KEK));

    // With the previous KEK gone, the store still opens: it was rewrapped, and the rows never moved.
    delete env.INTEGRATIONS_KEK_PREVIOUS;
    const dataKey = await unwrapDataKey(
      await importKek(NEXT_KEK, "INTEGRATIONS_KEK"),
      meta("data_key"),
      "g1",
    );
    const sealed = storage.db.prepare("SELECT sealed FROM rows").get()?.sealed as Uint8Array;
    expect(await openRow(await rowKey(dataKey, "decks", 1), "decks", "d-1", sealed)).toEqual(
      DECK("d-1"),
    );
    const later = await store.replace(
      "g1",
      "decks",
      await gz([DECK("d-2")]),
      { ms: 2, ctr: 0 },
      digestOf(2),
      3,
    );
    expect(later.status).toBe(200);
  });

  it("refuses, naming both bindings, a store whose key neither secret opens — and wipes nothing", async () => {
    const { storage, store, env } = await made();
    await store.replace("g1", "decks", await gz([DECK("d-1")]), { ms: 1, ctr: 0 }, digestOf(1), 2);
    env.INTEGRATIONS_KEK = NEXT_KEK;
    await expect(store.digests("g1")).rejects.toThrow(
      "a store's data key is wrapped under neither INTEGRATIONS_KEK nor INTEGRATIONS_KEK_PREVIOUS",
    );
    await expect(
      store.replace("g1", "decks", await gz([]), { ms: 2, ctr: 0 }, digestOf(2), 3),
    ).rejects.toThrow(/INTEGRATIONS_KEK_PREVIOUS/);
    expect(storage.db.prepare("SELECT count(*) AS n FROM rows").get()?.n).toBe(1);
  });
});
