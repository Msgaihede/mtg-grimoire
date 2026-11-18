import { describe, expect, it } from "vitest";
import { pageLimit } from "./pageLimit";

const page = (rows: number) => ({ items: Array.from({ length: rows }) });

describe("pageLimit", () => {
  it("is the ordinary page when nobody says the wall is owed more", () => {
    expect(pageLimit(0, undefined, 50, 200, undefined)).toBe(50);
    expect(pageLimit(50, [page(50)], 50, 200, undefined)).toBe(50);
  });

  it("asks a new page for what the wall is owed, between the page and the ceiling", () => {
    expect(pageLimit(50, [page(50)], 50, 200, 950)).toBe(200);
    expect(pageLimit(50, [page(50)], 50, 200, 120)).toBe(120);
    expect(pageLimit(50, [page(50)], 50, 200, 10)).toBe(50);
    expect(pageLimit(100, [page(100)], 100, 500, Infinity)).toBe(500);
  });

  /** A refetch walks the pages the cache holds and must end each one where it ended. */
  it("refetches a held page at the size it was fetched at, whatever is wanted", () => {
    const held = [page(50), page(200), page(200)];
    expect(pageLimit(0, held, 50, 200, undefined)).toBe(50);
    expect(pageLimit(50, held, 50, 200, undefined)).toBe(200);
    expect(pageLimit(250, held, 50, 200, 5)).toBe(200);
    // Rows that moved between two reads land a page part-way into a held one: the rest of it.
    expect(pageLimit(80, held, 50, 200, undefined)).toBe(170);
    // Past everything held is a new page.
    expect(pageLimit(450, held, 50, 200, undefined)).toBe(50);
  });
});
