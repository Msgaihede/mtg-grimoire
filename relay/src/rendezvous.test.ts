import { describe, expect, it } from "vitest";
import { fakeD1 } from "./fakeD1";
import { handleRendezvousGet, handleRendezvousPut, MAX_BLOB_CHARS } from "./rendezvous";

const RV = "0123456789abcdef0123456789abcdef";
const NOW = 1_800_000_000_000;
const env = () => ({ DB: fakeD1() }) as never;

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

  it("refuses a slot that is not one of the two", async () => {
    expect((await put(env(), "middle", "ABC")).status).toBe(400);
  });
});
