import { describe, expect, it } from "vitest";
import { fakeD1, fakeEnvOver, type Tables } from "./fakeD1";
import {
  handleRendezvousGet,
  handleRendezvousPut,
  MAX_BLOB_CHARS,
  sweepRendezvous,
} from "./rendezvous";

const RV = "0123456789abcdef0123456789abcdef";
const NOW = 1_800_000_000_000;
const env = () => ({ DB: fakeD1() }) as never;
/** A fake over tables the test holds, to see which table a slot's row went to. */
const fakeDatabaseOver = (tables: Tables) => fakeEnvOver(tables).DB;

const put = (e: never, slot: string, blob: string, now = NOW) =>
  handleRendezvousPut(new Request("https://r/", { method: "POST", body: JSON.stringify({ blob }) }), e, RV, slot, now);

describe("the pairing rendezvous", () => {
  it("carries a blob from one side to the other", async () => {
    const e = env();
    expect((await put(e, "join", "ABC")).status).toBe(204);
    const got = await handleRendezvousGet(e, RV, "join", NOW);
    expect(got.status).toBe(200);
    expect(await got.json()).toEqual({ blob: "ABC" });
  });

  it("keeps the two slots apart", async () => {
    const e = env();
    await put(e, "join", "ABC");
    expect((await handleRendezvousGet(e, RV, "offer", NOW)).status).toBe(404);
  });

  it("refuses a second write to a filled slot, and keeps the first", async () => {
    const e = env();
    await put(e, "join", "FIRST");
    expect((await put(e, "join", "SECOND")).status).toBe(409);
    expect(await (await handleRendezvousGet(e, RV, "join", NOW)).json()).toEqual({ blob: "FIRST" });
  });

  it("is empty once it has expired", async () => {
    const e = env();
    await put(e, "join", "ABC");
    expect((await handleRendezvousGet(e, RV, "join", NOW + 600_001)).status).toBe(404);
  });

  it("refuses an oversized blob", async () => {
    const e = env();
    expect((await put(e, "join", "X".repeat(MAX_BLOB_CHARS + 1))).status).toBe(413);
  });

  it("refuses a slot that is not one of the four", async () => {
    expect((await put(env(), "middle", "ABC")).status).toBe(400);
    // A name every object answers is not a slot either.
    expect((await put(env(), "constructor", "ABC")).status).toBe(400);
    expect((await handleRendezvousGet(env(), RV, "toString", NOW)).status).toBe(400);
  });
});

describe("the signing slots", () => {
  it("carry each side's signing key under the same rules as the first two", async () => {
    const e = env();
    for (const slot of ["offersig", "joinsig"]) {
      expect((await put(e, slot, `KEY-${slot}`)).status).toBe(204);
      expect(await (await handleRendezvousGet(e, RV, slot, NOW)).json()).toEqual({
        blob: `KEY-${slot}`,
      });
      // First writer wins, as on `offer` and `join`.
      expect((await put(e, slot, "SECOND")).status).toBe(409);
      expect((await handleRendezvousGet(e, RV, slot, NOW + 600_001)).status).toBe(404);
    }
  });

  it("hold four rows for one pairing, none of which answers for another", async () => {
    const e = env();
    for (const slot of ["offer", "join", "offersig", "joinsig"]) {
      expect((await put(e, slot, slot.toUpperCase())).status).toBe(204);
    }
    for (const slot of ["offer", "join", "offersig", "joinsig"]) {
      expect(await (await handleRendezvousGet(e, RV, slot, NOW)).json()).toEqual({
        blob: slot.toUpperCase(),
      });
    }
  });

  it("live in their own table, which the hourly sweep clears as well", async () => {
    // `pairing_rendezvous`'s `slot` is CHECKed to the first two in production, so the signing
    // slots cannot be rows there (`migrations/0001_…`).
    const tables: Tables = {};
    const d1 = fakeDatabaseOver(tables);
    const e = { DB: d1 } as never;
    await put(e, "joinsig", "K");
    await put(e, "join", "J");
    expect(tables.pairing_slots?.map((row) => row.slot)).toEqual(["joinsig"]);
    expect(tables.pairing_rendezvous?.map((row) => row.slot)).toEqual(["join"]);

    await sweepRendezvous(e, NOW + 600_001);
    expect(tables.pairing_slots).toEqual([]);
    expect(tables.pairing_rendezvous).toEqual([]);
  });

  it("refuse an oversized blob, as the first two do", async () => {
    expect((await put(env(), "offersig", "X".repeat(MAX_BLOB_CHARS + 1))).status).toBe(413);
  });
});
