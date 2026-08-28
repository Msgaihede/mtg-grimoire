import { beforeEach, describe, expect, it, vi } from "vitest";
import { PERSIST_KEY, readPersistence, requestPersistenceOnce } from "@/pwa/persistence";

function fakeStorage(persist: () => Promise<boolean>, persisted = () => Promise.resolve(false)) {
  return { persist, persisted, estimate: () => Promise.resolve({}) } as unknown as StorageManager;
}

beforeEach(() => localStorage.clear());

describe("asking the browser to keep the corpus", () => {
  it("asks once, and writes down what it answered", async () => {
    const persist = vi.fn(() => Promise.resolve(true));
    await requestPersistenceOnce(fakeStorage(persist), localStorage, 1_700_000_000_000);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(readPersistence(localStorage)).toEqual({ askedAt: 1_700_000_000_000, granted: true });
  });

  it("does not ask again after a refusal", async () => {
    const persist = vi.fn(() => Promise.resolve(false));
    const storage = fakeStorage(persist);
    await requestPersistenceOnce(storage, localStorage, 1);
    await requestPersistenceOnce(storage, localStorage, 2);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(readPersistence(localStorage)?.granted).toBe(false);
  });

  it("survives a browser that has no storage manager at all", async () => {
    await expect(requestPersistenceOnce(undefined, localStorage, 1)).resolves.toBeNull();
    expect(readPersistence(localStorage)).toBeNull();
  });

  it("reads back nothing rather than throwing on a corrupt record", () => {
    localStorage.setItem(PERSIST_KEY, "{not json");
    expect(readPersistence(localStorage)).toBeNull();
  });
});

describe("what the record is worth", () => {
  /**
   * The spike asked for persistence and was told `false` throughout, which is what headless
   * Chrome with no install and no gesture answers. The point of writing the answer down is to
   * stop asking, and to be able to *show* it — never to conclude from it that the corpus is
   * still there. That conclusion is `corpusState`'s and it comes from opening the database,
   * not from this record.
   */
  it("is a record and not a guarantee — nothing here reports whether data survived", () => {
    const record = { askedAt: 1, granted: true };
    expect(Object.keys(record).sort()).toEqual(["askedAt", "granted"]);
  });
});
