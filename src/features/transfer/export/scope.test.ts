import { describe, expect, it, vi } from "vitest";
import { SWEEP_PAGE, sweep } from "./scope";

describe("sweep", () => {
  it("keeps asking until it has the whole set", async () => {
    const rows = Array.from({ length: 1200 }, (_, i) => ({ id: i }));
    const page = vi.fn(async (limit: number, offset: number) => ({
      items: rows.slice(offset, offset + limit),
      total: rows.length,
    }));

    const all = await sweep(page);

    expect(all).toHaveLength(1200);
    expect(page).toHaveBeenCalledTimes(3);
    expect(page).toHaveBeenNthCalledWith(1, SWEEP_PAGE, 0);
    expect(page).toHaveBeenNthCalledWith(3, SWEEP_PAGE, 1000);
  });

  it("stops on a short page rather than trusting the total, which can move mid-sweep", async () => {
    const page = vi.fn(async (_limit: number, offset: number) =>
      offset === 0 ? { items: [{ id: 1 }], total: 9999 } : { items: [], total: 9999 },
    );
    expect(await sweep(page)).toHaveLength(1);
    expect(page).toHaveBeenCalledTimes(1);
  });

  it("reports progress against the total it was told", async () => {
    const rows = Array.from({ length: 600 }, (_, i) => ({ id: i }));
    const seen: number[] = [];
    await sweep(
      async (limit, offset) => ({ items: rows.slice(offset, offset + limit), total: 600 }),
      (loaded) => seen.push(loaded),
    );
    expect(seen).toEqual([500, 600]);
  });

  it("answers an empty list without asking twice", async () => {
    const page = vi.fn(async () => ({ items: [], total: 0 }));
    expect(await sweep(page)).toEqual([]);
    expect(page).toHaveBeenCalledTimes(1);
  });
});
