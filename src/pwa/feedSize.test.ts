import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROMPT_OVER_BYTES,
  clearFeedSizeCache,
  probeFeedSize,
  shouldPrompt,
} from "@/pwa/feedSize";

// The probe caches per session, so without this every case after the first `corpus` one would
// be answered by the previous case's fixture. The plan's test file had no such hook and its
// last `corpus` case would have read the first's 77 972 714 instead of the failure it stages.
beforeEach(() => clearFeedSizeCache());

describe("finding out what a feed costs", () => {
  it("reads the corpus size out of Scryfall's own bulk descriptor", async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ compressed_size: 77_972_714 }),
      } as unknown as Response),
    );
    const size = await probeFeedSize("corpus", fetchFn);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.scryfall.com/bulk-data/default_cards",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
    expect(size).toEqual({ bytes: 77_972_714, exact: true });
  });

  it("reads the combo feed's size off a HEAD", async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve({
        ok: true,
        headers: { get: (h: string) => (h.toLowerCase() === "content-length" ? "27558428" : null) },
      } as unknown as Response),
    );
    const size = await probeFeedSize("combos", fetchFn);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://json.commanderspellbook.com/variants.json.gz",
      expect.objectContaining({ method: "HEAD" }),
    );
    expect(size).toEqual({ bytes: 27_558_428, exact: true });
  });

  /**
   * Measured live 2026-08-28: a HEAD on `api.cardkingdom.com/api/v2/pricelist` answers 200 with
   * `Content-Type: text/html` and **no `Content-Length`**, and the feed is paginated, so there is
   * no single number to read. The price research measured the whole payload at 66 787 283 B
   * uncompressed — big enough to prompt about and not a number this app can confirm today.
   */
  it("admits it cannot size the Card Kingdom feed, and does not guess", async () => {
    const fetchFn = vi.fn();
    expect(await probeFeedSize("card-kingdom", fetchFn)).toEqual({ bytes: null, exact: false });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("answers null rather than throwing when the probe fails", async () => {
    const size = await probeFeedSize("corpus", () => Promise.reject(new Error("offline")));
    expect(size).toEqual({ bytes: null, exact: false });
  });

  /**
   * Two requests per refresh is what Scryfall's rule allows and no more: the probe and the
   * download's own descriptor read are separated by a human press. Asking again per press would
   * not be.
   */
  it("asks once a session, and a failure is not cached", async () => {
    const ok = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ compressed_size: 77_972_714 }),
      } as unknown as Response),
    );
    await probeFeedSize("corpus", ok);
    await probeFeedSize("corpus", ok);
    expect(ok).toHaveBeenCalledTimes(1);

    clearFeedSizeCache();
    const bad = vi.fn(() => Promise.reject(new Error("offline")));
    await probeFeedSize("corpus", bad);
    await probeFeedSize("corpus", bad);
    // A network that was down a moment ago may be up now, and an unknown size is the one case
    // that always prompts — so caching the failure would ask about a feed forever.
    expect(bad).toHaveBeenCalledTimes(2);
  });
});

describe("whether to ask", () => {
  it("does not ask about anything under 5 MB", () => {
    expect(shouldPrompt({ bytes: 4_000_000, exact: true }, { metered: false, why: null }).show).toBe(
      false,
    );
  });

  it("asks about anything over it", () => {
    expect(PROMPT_OVER_BYTES).toBe(5_000_000);
    expect(
      shouldPrompt({ bytes: 27_558_428, exact: true }, { metered: false, why: null }).show,
    ).toBe(true);
  });

  /** An unknown size is the one case where not asking would be the reckless answer. */
  it("asks when it does not know", () => {
    expect(shouldPrompt({ bytes: null, exact: false }, { metered: false, why: null }).show).toBe(
      true,
    );
  });

  it("defaults to Not now on a metered link, and to the download otherwise", () => {
    const big = { bytes: 77_972_714, exact: true };
    expect(shouldPrompt(big, { metered: true, why: "Data Saver is on" }).preferred).toBe("not-now");
    expect(shouldPrompt(big, { metered: false, why: null }).preferred).toBe("download");
  });
});
