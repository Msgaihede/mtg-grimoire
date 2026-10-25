import { describe, expect, it } from "vitest";
import { inflate, MAX_INFLATED_BYTES } from "../src/body";
import { FIELD_NAMES } from "../src/projection";
import { macKey, newDataKey, rowKey, rowMac, sealRow } from "../src/seal";
import { Store } from "../src/store";
import { ALL_ON, digestOf, documentOf, gzip, KEK, sqlStorage } from "./fake";

/**
 * **How long a store takes to ingest a `collection_entries` table**, at 1,000, 10,000 and 50,000
 * rows, in the two cases that matter: a first publish into an empty table, and a republish with
 * one row changed — inflate, parse, check, MAC every row, seal what changed and write it in one
 * transaction — under Node, over `node:sqlite`, with the rows written as the fake counts them.
 * Skipped unless `MEASURE` is set, because it is a measurement and not a check: it asserts only
 * that every row landed and what a republish wrote.
 *
 *   MEASURE=1 pnpm exec vitest run --project integrations-worker measure
 *
 * **What it is not**: workerd's time. Node's WebCrypto goes through a thread pool, so its per-call
 * cost is several times workerd's; the shape — where the time goes, and how a republish compares
 * with a first publish — is what this is for. "MAC" and "sealing" are timed apart from the
 * ingest, over the same rows under keys of their own.
 */

/** A row as the Rust projects one under every field on — plan §3.1's example, made plural. */
function entry(i: number, quantity = 1 + (i % 4)) {
  return {
    uid: `01J${String(i).padStart(23, "0")}`,
    scryfallId: `${String(i).padStart(8, "0")}-1111-2222-3333-444455556666`,
    name: `Card number ${i}`,
    set: "mh3",
    cn: String(i % 400),
    finish: i % 7 === 0 ? "foil" : "nonfoil",
    quantity,
    folderUid: `folder-${i % 12}`,
    image: `https://cards.scryfall.io/normal/front/0/0/${String(i).padStart(8, "0")}.jpg`,
    condition: "NM",
    lang: "en",
    value: (i % 1000) / 100,
    tags: i % 5 === 0 ? ["trade"] : [],
    notes: i % 9 === 0 ? "opened at the prerelease" : undefined,
  };
}

async function timed<T>(work: () => Promise<T>): Promise<[T, number]> {
  const start = performance.now();
  const out = await work();
  return [out, performance.now() - start];
}

describe.skipIf(!process.env.MEASURE)("inflating at the cap (MEASURE=1)", () => {
  /**
   * The review's experiment (2026-10-25), at the new cap: buffers allocated while a document of
   * nearly twenty-four mebibytes inflates, sampled every millisecond. The text it ends with is a
   * string, not a buffer. **No collection is forced**, so a chunk already decoded and let go but
   * not yet collected still counts: this is an upper bound on what the decompressor's chunks
   * cost, not what `inflate` keeps — it keeps one chunk at a time.
   */
  it("allocates chunks in flight, and keeps only the text", async () => {
    const gz = await gzip(new Uint8Array(MAX_INFLATED_BYTES - 1024).fill(0x20));
    const usage = () =>
      (process as unknown as { memoryUsage(): { arrayBuffers: number } }).memoryUsage();
    const base = usage().arrayBuffers;
    let peak = base;
    const timer = setInterval(() => (peak = Math.max(peak, usage().arrayBuffers)), 1);
    const out = await inflate(gz);
    peak = Math.max(peak, usage().arrayBuffers);
    clearInterval(timer);
    expect("text" in out).toBe(true);
    console.log(
      `[measure] inflating ${(MAX_INFLATED_BYTES / 1048576).toFixed(0)} MiB less 1 KiB (gzip ${(gz.length / 1024).toFixed(0)} KiB): ` +
        `buffers peaked ${((peak - base) / 1048576).toFixed(1)} MiB over the start`,
    );
  });
});

describe.skipIf(!process.env.MEASURE)("ingesting collection_entries (MEASURE=1)", () => {
  it.each([1_000, 10_000, 50_000])("%i rows", async (count) => {
    const rows = Array.from({ length: count }, (_, i) => entry(i));
    const json = JSON.stringify(documentOf("collection_entries", rows, [...FIELD_NAMES]));
    const gz = await gzip(json);
    const moved = rows.map((row, i) => (i === count >> 1 ? entry(i, row.quantity + 1) : row));
    const gzMoved = await gzip(
      JSON.stringify(documentOf("collection_entries", moved, [...FIELD_NAMES])),
    );

    const storage = sqlStorage();
    const store = new Store(storage, { INTEGRATIONS_KEK: KEK });
    await store.settings("g1", { fields: ALL_ON, marketplace: "tcgplayer" }, true, 1);

    // The two crypto halves, apart: every row MACed, and every row (or the one) sealed.
    const dataKey = newDataKey();
    const macWith = await macKey(dataKey);
    const sealWith = await rowKey(dataKey, "collection_entries", 1);
    const batches = async (items: unknown[], work: (row: never) => Promise<unknown>) => {
      for (let at = 0; at < items.length; at += 512) {
        await Promise.all(items.slice(at, at + 512).map((row) => work(row as never)));
      }
    };
    const [, macMs] = await timed(() =>
      batches(rows, (row: object) => rowMac(macWith, "collection_entries", row)),
    );
    const [, sealAllMs] = await timed(() =>
      batches(rows, (row: { uid: string }) => sealRow(sealWith, "collection_entries", row)),
    );
    const [, sealOneMs] = await timed(() =>
      sealRow(sealWith, "collection_entries", moved[count >> 1]),
    );

    const written = () => ({ ...storage.written });
    const before = written();
    const [first, firstMs] = await timed(() =>
      store.replace("g1", "collection_entries", gz, { ms: 1, ctr: 0 }, digestOf(1), 2),
    );
    expect(first.status).toBe(200);
    const afterFirst = written();
    const [again, againMs] = await timed(() =>
      store.replace("g1", "collection_entries", gzMoved, { ms: 2, ctr: 0 }, digestOf(2), 3),
    );
    expect(again.status).toBe(200);
    const afterAgain = written();
    expect(storage.db.prepare("SELECT count(*) AS n FROM rows").get()?.n).toBe(count);

    const delta = (a: Record<string, number>, b: Record<string, number>) =>
      Object.keys(b)
        .filter((k) => b[k] !== (a[k] ?? 0))
        .map((k) => `${k} ${b[k] - (a[k] ?? 0)}`)
        .join(", ");
    expect(afterAgain.rows - afterFirst.rows).toBe(1);

    const kib = (n: number) => `${(n / 1024).toFixed(0)} KiB`;
    console.log(
      `[measure] collection_entries ${count} rows (JSON ${kib(json.length)}, gzip ${kib(gz.length)}):\n` +
        `  first publish: ingest ${firstMs.toFixed(0)} ms; MAC ${macMs.toFixed(0)} ms, sealing ${sealAllMs.toFixed(0)} ms (${count} rows); written: ${delta(before, afterFirst)}\n` +
        `  one row moved: ingest ${againMs.toFixed(0)} ms; MAC ${macMs.toFixed(0)} ms, sealing ${sealOneMs.toFixed(1)} ms (1 row); written: ${delta(afterFirst, afterAgain)}`,
    );
  });
});
