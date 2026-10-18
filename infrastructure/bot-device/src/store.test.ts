import { describe, expect, it } from "vitest";
import { sqlStorage } from "./fake";
import { REVOKED, SqlPageStore } from "./store";

const page = (b: number) => new Uint8Array(40).fill(b);

describe("the page store", () => {
  it("keeps a file's pages and its length, and reads back what it was given", () => {
    const store = new SqlPageStore(sqlStorage());
    expect(store.size("user.db")).toBeNull();
    store.commit("user.db", 8192, [0, 1], [page(1), page(2)], null);
    expect(store.size("user.db")).toBe(8192);
    expect(store.read("user.db", 1)).toEqual(page(2));
    expect(store.read("user.db", 2)).toBeNull();
    expect(store.read("corpus.db", 0)).toBeNull();
  });

  it("rewrites a page in place and truncates before it writes", () => {
    const store = new SqlPageStore(sqlStorage());
    store.commit("user.db", 3 * 4096, [0, 1, 2], [page(1), page(2), page(3)], null);
    store.commit("user.db", 2 * 4096, [1], [page(9)], 1);
    expect(store.read("user.db", 1)).toEqual(page(9));
    expect(store.read("user.db", 2)).toBeNull();
    expect(store.read("user.db", 0)).toEqual(page(1));
  });

  it("commits all of a transaction or none of it", () => {
    const storage = sqlStorage();
    const store = new SqlPageStore(storage);
    store.commit("user.db", 4096, [0], [page(1)], null);
    // A page that is not bytes fails the insert half-way through: nothing of the step lands.
    expect(() =>
      store.commit("user.db", 8192, [0, 1], [page(5), {} as Uint8Array], null),
    ).toThrow();
    expect(store.read("user.db", 0)).toEqual(page(1));
    expect(store.size("user.db")).toBe(4096);
  });

  it("removes a file whole", () => {
    const store = new SqlPageStore(sqlStorage());
    store.commit("corpus.db", 4096, [0], [page(1)], null);
    store.remove("corpus.db");
    expect(store.size("corpus.db")).toBeNull();
    expect(store.read("corpus.db", 0)).toBeNull();
  });

  it("refuses everything once revoked, so nothing is written back after deleteAll", () => {
    const store = new SqlPageStore(sqlStorage());
    store.revoke();
    expect(() => store.size("user.db")).toThrow(REVOKED);
    expect(() => store.commit("user.db", 1, [], [], null)).toThrow(REVOKED);
    expect(() => store.remove("user.db")).toThrow(REVOKED);
  });
});
