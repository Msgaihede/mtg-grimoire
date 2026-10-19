import { describe, expect, it } from "vitest";
import { sqlStorage } from "./fake";
import { PROPOSAL_TTL_MS, Proposals, proposalId, proposalKey } from "./proposals";

const KEK = Buffer.from(new Uint8Array(32).fill(7)).toString("base64url");
const proposal = (id = proposalId(), expiresAt = 1000 + PROPOSAL_TTL_MS) => ({
  id,
  discordUserId: "200000000000000001",
  add: { table: "collection", cardId: "c" },
  summary: "1× Sol Ring — … — to Binder",
  expiresAt,
});

describe("the proposals", () => {
  it("keep a proposal under a key derived from BOT_KEK and the object, and give it back", async () => {
    const store = new Proposals(sqlStorage(), () => proposalKey(KEK, "object-1"));
    const one = proposal();
    await store.put(one);
    expect(await store.get(one.id, 1000)).toEqual(one);
    store.delete(one.id);
    expect(await store.get(one.id, 1000)).toBeNull();
  });

  it("are no proposal under another object's key, and that row is dropped", async () => {
    const storage = sqlStorage();
    const one = proposal();
    await new Proposals(storage, () => proposalKey(KEK, "object-1")).put(one);
    const other = new Proposals(storage, () => proposalKey(KEK, "object-2"));
    expect(await other.get(one.id, 1000)).toBeNull();
    expect(other.count()).toBe(0);
  });

  it("purge what is past its time on every read", async () => {
    const store = new Proposals(sqlStorage(), () => proposalKey(KEK, "o"));
    await store.put(proposal(proposalId(), 2000));
    const late = proposal(proposalId(), 5000);
    await store.put(late);
    expect(await store.get(late.id, 2000)).not.toBeNull();
    expect(store.count()).toBe(1);
  });

  it("refuse a BOT_KEK that is not 32 bytes, and an id that is not one", async () => {
    await expect(proposalKey("c2hvcnQ", "o")).rejects.toThrow(/32 bytes/);
    const store = new Proposals(sqlStorage(), () => proposalKey(KEK, "o"));
    expect(await store.get("not-an-id", 0)).toBeNull();
    expect(proposalId()).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});
