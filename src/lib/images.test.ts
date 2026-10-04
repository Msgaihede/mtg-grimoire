import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cardImageUrl,
  imageOrigin,
  imageRetryDelayMs,
  IMAGE_RETRY_CEILING_MS,
  IMAGE_RETRY_FLOOR_MS,
  IMAGE_RETRY_SPREAD_MS,
  WEB_IMAGE_PREFIX,
  webImageOrigin,
} from "@/lib/images";

/**
 * Tauri serves a custom protocol from a different origin on every platform: Windows and Android
 * get `http://<scheme>.localhost/`, everything else `<scheme>://localhost/`. The app is
 * Windows-first, but the wrong branch is a page of broken images rather than a type error, so
 * both are pinned.
 */
describe("imageOrigin", () => {
  it("uses the http form on Windows", () => {
    expect(imageOrigin("Mozilla/5.0 (Windows NT 10.0; Win64; x64) WebView2/1.0")).toBe(
      "http://mtgimg.localhost",
    );
  });

  it("uses the http form on Android, where the light app's host serves it", () => {
    expect(
      imageOrigin(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0 Mobile Safari/537.36",
      ),
    ).toBe("http://mtgimg.localhost");
  });

  it("uses the scheme form everywhere else", () => {
    expect(imageOrigin("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe(
      "mtgimg://localhost",
    );
  });
});

/**
 * The web app has no custom protocol: the same path is asked of the app's own origin, under a
 * prefix its service worker answers. Which build this is, is the build's mode — so every other
 * build, this suite's included, still answers the three cases above.
 */
describe("imageOrigin in the web app's build", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is the app's own origin and the picture prefix, whatever the browser says it is", () => {
    vi.stubEnv("MODE", "web");
    const own = `${window.location.origin}/mtgimg`;
    expect(imageOrigin("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/154.0")).toBe(own);
    expect(imageOrigin("Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/154.0 Mobile")).toBe(own);
    expect(imageOrigin("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe(own);
  });

  it("keeps the path's shape, so no call site changes", () => {
    vi.stubEnv("MODE", "web");
    expect(cardImageUrl("0000419b-0bba-4488-8f7a-6194544ce91d", 1, "display")).toBe(
      `${window.location.origin}/mtgimg/display/0000419b-0bba-4488-8f7a-6194544ce91d/1`,
    );
  });

  it("puts the prefix where no place of the app is, and spells it once", () => {
    expect(WEB_IMAGE_PREFIX).toBe("/mtgimg");
    expect(webImageOrigin("https://mtg-grimoire.app")).toBe("https://mtg-grimoire.app/mtgimg");
    // In every other mode — this one is `test` — the protocol's origins stand.
    expect(imageOrigin("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe(
      "mtgimg://localhost",
    );
  });
});

describe("cardImageUrl", () => {
  it("spells the path the Rust handler parses", () => {
    const url = cardImageUrl("0000419b-0bba-4488-8f7a-6194544ce91d", 0, "grid");

    expect(url).toMatch(/\/grid\/0000419b-0bba-4488-8f7a-6194544ce91d\/0$/);
  });

  it("addresses the back face separately", () => {
    const front = cardImageUrl("ab000000-0000-0000-0000-000000000001", 0, "display");
    const back = cardImageUrl("ab000000-0000-0000-0000-000000000001", 1, "display");

    expect(front).not.toBe(back);
    expect(back).toMatch(/\/1$/);
  });
});

/**
 * The renderer cannot read the `Retry-After` the protocol sends with a 503: an `<img>`
 * error event carries no headers, and the app's CSP allows `mtgimg:` under `img-src`
 * only, so a `fetch` that could read them is blocked before it is sent (and would be
 * cross-origin and header-less anyway). What is left is to never come back sooner than
 * the floor `images.rs` clamps its own penalty to, and to double from there — a real
 * `Retry-After: 60` is a lockout the first retry lands in the middle of.
 */
describe("imageRetryDelayMs", () => {
  it("never retries inside the protocol's own rate-limit floor", () => {
    expect(imageRetryDelayMs(1, 0)).toBe(IMAGE_RETRY_FLOOR_MS);
    for (let i = 0; i < 200; i++) {
      expect(imageRetryDelayMs(1)).toBeGreaterThanOrEqual(IMAGE_RETRY_FLOOR_MS);
    }
  });

  it("doubles per attempt, so a lockout longer than the floor still heals", () => {
    expect(imageRetryDelayMs(2, 0)).toBe(2 * IMAGE_RETRY_FLOOR_MS);
    expect(imageRetryDelayMs(3, 0)).toBe(4 * IMAGE_RETRY_FLOOR_MS);
  });

  it("stops doubling at the longest lockout the protocol will report", () => {
    // Past 300 s the fetcher's own gate has reopened, so a longer wait buys nothing and
    // an unbounded double would park a tile for hours.
    expect(imageRetryDelayMs(9, 0)).toBe(IMAGE_RETRY_CEILING_MS);
  });

  it("spreads a screenful of retries over a window instead of one tick", () => {
    // A screenful is ~40 tiles and they all fail in the same instant, so an undithered
    // delay would send all 40 back at once — the herd the backoff exists to prevent.
    const delays = new Set(Array.from({ length: 200 }, () => imageRetryDelayMs(1)));

    expect(delays.size).toBeGreaterThan(1);
    expect(Math.max(...delays)).toBeLessThan(IMAGE_RETRY_FLOOR_MS + IMAGE_RETRY_SPREAD_MS);
  });
});
