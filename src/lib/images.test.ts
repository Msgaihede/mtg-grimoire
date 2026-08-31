import { beforeEach, describe, expect, it, vi } from "vitest";
import { isWebTarget } from "@/pwa/target";
import imageUriRs from "../../src-tauri/src/image_uri.rs?raw";
import {
  cardArtSrc,
  cardImageUrl,
  imageOrigin,
  imageRetryDelayMs,
  IMAGE_VARIANTS,
  IMAGE_RETRY_CEILING_MS,
  IMAGE_RETRY_FLOOR_MS,
  IMAGE_RETRY_SPREAD_MS,
  WALL_CARD_VARIANT,
} from "@/lib/images";

/**
 * Which build is answering. `isWebTarget()` is a `define` folded away at build time, so the
 * web branch is unreachable from a suite that runs on `vite.config.ts` — mocking the module is
 * the only way to exercise it, and it is the seam `src/pwa/target.ts`'s own comment names.
 *
 * `false` by default, because that is what the real function answers here — pinned below rather
 * than assumed, so a mock that has quietly become the *only* thing saying "desktop" is caught.
 */
vi.mock("@/pwa/target", () => ({ isWebTarget: vi.fn(() => false) }));

beforeEach(() => {
  vi.mocked(isWebTarget).mockReturnValue(false);
});

/**
 * Tauri serves a custom protocol from a different origin on every platform: Windows and
 * Android get `http://<scheme>.localhost/`, everything else `<scheme>://localhost/`. The
 * app is Windows-first, but the wrong branch is a page of broken images rather than a
 * type error, so both are pinned.
 */
describe("imageOrigin", () => {
  it("uses the http form on Windows", () => {
    expect(imageOrigin("Mozilla/5.0 (Windows NT 10.0; Win64; x64) WebView2/1.0")).toBe(
      "http://mtgimg.localhost",
    );
  });

  it("uses the scheme form everywhere else", () => {
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
 * The desktop/web branch, which is the whole of what a card frame has to decide and is
 * deliberately not decided in a component.
 *
 * Two different pictures of one card: the local cache's, re-encoded to the variant's exact
 * size and reachable only through a Tauri custom protocol, and Scryfall's own URL, which is
 * the only one a browser can fetch because **wasm cannot register a URL scheme**. Getting it
 * backwards is silent in both directions — a desktop wall that refetched every tile over the
 * network still draws cards, and a browser handed `mtgimg://` draws broken images with nothing
 * on screen saying why.
 */
describe("cardArtSrc", () => {
  const PROTOCOL = cardImageUrl("0000419b-0bba-4488-8f7a-6194544ce91d", 0, "display");
  const SUPPLIED = "https://cards.scryfall.io/large/front/0/0/0000419b.jpg?1706230661";

  /**
   * **The row carries a URL on both builds** — one DTO, one shape — so "ignored" rather than
   * "not passed" is what the desktop side has to be true of. A wall that preferred it would
   * refetch a screenful of art the cache already holds, at Scryfall's expense, every scroll.
   */
  it("draws the cached protocol picture on the desktop build, even for a row carrying its own URL", () => {
    expect(cardArtSrc(PROTOCOL, SUPPLIED)).toBe(PROTOCOL);
    expect(cardArtSrc(PROTOCOL, SUPPLIED)).not.toContain("scryfall.io");
  });

  it("draws the row's own URL verbatim on the web build", () => {
    vi.mocked(isWebTarget).mockReturnValue(true);

    expect(cardArtSrc(PROTOCOL, SUPPLIED)).toBe(SUPPLIED);
  });

  /**
   * `null` is the frame's *no art* state, and it has to be the answer rather than a fallback to
   * the protocol URL: a printing whose only picture is Scryfall's `soon.jpg` placeholder reaches
   * the page with no URL at all, and a browser handed `mtgimg://` for it would draw a broken
   * `<img>` where a named, empty card frame belongs.
   */
  it("answers null on web for a printing with no picture, never the unreachable protocol URL", () => {
    vi.mocked(isWebTarget).mockReturnValue(true);

    expect(cardArtSrc(PROTOCOL, undefined)).toBeNull();
    expect(cardArtSrc(PROTOCOL, null)).toBeNull();
  });

  /** An orphan — a row whose card has left the database — fetches nothing on either build. */
  it("answers null for a row with no card at all", () => {
    expect(cardArtSrc(null, undefined)).toBeNull();
    vi.mocked(isWebTarget).mockReturnValue(true);
    expect(cardArtSrc(null, undefined)).toBeNull();
  });

  /**
   * The mock above defaults to `false` because that is what the *real* module answers under
   * vitest — `vite.config.ts` defines `__CORE__` as `"tauri"` and the suite runs on that config.
   * Stated rather than assumed: without this the desktop assertions are checking a mock's
   * default and would go on passing if the shipped default flipped.
   */
  it("is the desktop build that vitest actually runs, which is what the default above states", async () => {
    const actual = await vi.importActual<typeof import("@/pwa/target")>("@/pwa/target");

    expect(actual.isWebTarget()).toBe(false);
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

/**
 * **The wall's variant is spelled in two languages, and this is the only thing that compares
 * them.**
 *
 * `src-tauri/src/image_uri.rs`'s `LIST_VARIANT` decides which URL `CardSummary` carries — it is
 * the one string in that module that reaches SQL unbound — and `WALL_CARD_VARIANT` decides which
 * key `CardGrid` reads back out of the map. **They are the same fact written twice**, and the
 * failure when they disagree is silent in the specific way this file's neighbours already
 * document: the DTO carries one variant, the tile asks for another, the lookup misses, and every
 * card on a browser's wall draws the no-art frame — which is exactly what a card with no picture
 * is *supposed* to look like. Nothing is thrown and nothing is logged.
 *
 * The `?raw` import is `viewports.test.ts`'s idiom for the same shape of problem — a fact Rust
 * owns and TypeScript only quotes — and it is used here for the same reason: this project has no
 * `@types/node` and cannot reach `node:fs`.
 */
const LIST_VARIANT = /pub const LIST_VARIANT: &str = "([a-z]+)";/.exec(imageUriRs)?.[1];

describe("the wall's variant, across the language boundary", () => {
  it("is the same string Rust puts on the DTO", () => {
    // Its own assertion: a renamed constant makes the capture `undefined`, and
    // `expect(undefined).toBe(...)` would read as a *changed* variant rather than a missing
    // one — two different repairs.
    expect(LIST_VARIANT).toBeDefined();
    expect(WALL_CARD_VARIANT).toBe(LIST_VARIANT);
  });

  it("is a variant this app actually draws", () => {
    // Rust fences that the name is a column that exists; nothing over here did until now.
    expect(IMAGE_VARIANTS).toContain(WALL_CARD_VARIANT);
  });
});
