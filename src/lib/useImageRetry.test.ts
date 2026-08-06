import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cardImageUrl,
  IMAGE_RETRY_FLOOR_MS,
  IMAGE_RETRY_LIMIT,
  IMAGE_RETRY_SPREAD_MS,
} from "@/lib/images";
import { useImageRetry } from "./useImageRetry";

/**
 * A real image URL, because the retry marker is a query string appended to it.
 *
 * `mtgimg:` URLs are `<origin>/<variant>/<id>/<face>` and nothing else — no query, ever —
 * so `?retry=N` is always the first one and never has to be `&`. That is asserted rather
 * than assumed, because the day it stops being true is the day the marker silently becomes
 * part of the *previous* parameter's value.
 */
const BASE = cardImageUrl("aaa", 0, "grid");
const OTHER = cardImageUrl("bbb", 0, "grid");

/** Long enough to cover the first dithered wait whatever `Math.random` returned. */
const PAST_THE_RETRY = IMAGE_RETRY_FLOOR_MS + IMAGE_RETRY_SPREAD_MS;

afterEach(() => {
  vi.useRealTimers();
});

/** The hook under a changing `src`, which is the half a plain `renderHook` cannot reach. */
function retry(src: string | null = BASE) {
  return renderHook(({ src }: { src: string | null }) => useImageRetry(src), {
    initialProps: { src },
  });
}

describe("useImageRetry", () => {
  it("hands back the plain URL, unmarked, until something has failed", () => {
    expect(BASE).not.toContain("?");

    const { result } = retry();

    expect(result.current.src).toBe(BASE);
    expect(result.current.retrying).toBe(false);
    expect(result.current.failed).toBe(false);
  });

  /**
   * The self-healing half of the rate limit. A 429 anywhere in the image fetcher makes every
   * uncached image fail fast with a 503, and a plain `<img>` that errors once stays broken for
   * the rest of the session — the art never comes back, even though the lockout ends in half a
   * minute. So the caller is told to draw something else, and handed a *different* URL once
   * the floor has passed: the marker is what stops anything between here and the protocol from
   * answering the retry out of whatever it made of the failure.
   */
  it("goes quiet on a failure and comes back marked, no sooner than the rate-limit floor", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { result } = retry();

    act(() => result.current.onError());

    // Nothing to draw, and a reason: the caller says "Retrying…" rather than "No image".
    expect(result.current.src).toBeNull();
    expect(result.current.retrying).toBe(true);
    expect(result.current.failed).toBe(false);

    // Coming back inside the window is what Scryfall escalates to bans over.
    await act(async () => void vi.advanceTimersByTime(IMAGE_RETRY_FLOOR_MS - 1));
    expect(result.current.src).toBeNull();

    await act(async () => void vi.advanceTimersByTime(PAST_THE_RETRY));
    expect(result.current.src).toBe(`${BASE}?retry=1`);
    expect(result.current.retrying).toBe(false);
  });

  /**
   * The first retry lands 30 s in, which is inside any lockout longer than the floor — a real
   * `Retry-After: 60` fails it against a gate that is still shut. Spending the only attempt
   * there is how a self-healing image stops healing, so it re-arms once more at double the wait.
   */
  it("re-arms once at double the delay when the first retry lands in the lockout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { result } = retry();

    act(() => result.current.onError());
    await act(async () => void vi.advanceTimersByTime(PAST_THE_RETRY));
    act(() => result.current.onError());

    // Not on the first schedule again: the second wait is twice the floor, which is past the
    // 60 s lockout that swallowed the first one.
    await act(async () => void vi.advanceTimersByTime(2 * IMAGE_RETRY_FLOOR_MS - 1));
    expect(result.current.src).toBeNull();
    expect(result.current.retrying).toBe(true);

    await act(async () => void vi.advanceTimersByTime(IMAGE_RETRY_SPREAD_MS + 1));
    expect(result.current.src).toBe(`${BASE}?retry=2`);
  });

  it("stops after those two retries rather than hammering a protocol that is saying no", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { result } = retry();

    for (let i = 0; i <= IMAGE_RETRY_LIMIT; i++) {
      act(() => result.current.onError());
      await act(async () => void vi.advanceTimersByTime(2 * PAST_THE_RETRY));
    }

    // Ten minutes later, still no fourth request: something that has failed three times over
    // five minutes is something the app cannot reach, and 40 of them polling forever is the
    // herd the backoff exists to prevent. A remount is what asks again, because that is a
    // reader saying "now".
    await act(async () => void vi.advanceTimersByTime(10 * 60_000));
    expect(vi.getTimerCount()).toBe(0);
    expect(result.current.src).toBeNull();
    expect(result.current.failed).toBe(true);
    expect(result.current.retrying).toBe(false);
  });

  it("leaves nothing scheduled once the image is back", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { result } = retry();

    act(() => result.current.onError());
    // One timer per image, never a queue of them.
    expect(vi.getTimerCount()).toBe(1);

    await act(async () => void vi.advanceTimersByTime(PAST_THE_RETRY));

    // The retry landed, so the schedule is spent: nothing is left to fire into an image that
    // is already on screen.
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => void vi.advanceTimersByTime(10 * 60_000));
    expect(result.current.src).toBe(`${BASE}?retry=1`);
  });

  /**
   * The half that is easy to leave behind, because nothing breaks the day it is written: the
   * caller usually belongs to a *slot* rather than to a card — a tile in a virtualised wall, a
   * deck's cover frame — so a new image arrives without a remount. Without the reset the new
   * URL inherits the old one's failure, which is a frame stuck on "No image" over a picture
   * that is perfectly fetchable.
   */
  it("forgets a failure when it is handed a different image", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { result, rerender } = retry();

    act(() => result.current.onError());
    expect(result.current.retrying).toBe(true);

    rerender({ src: OTHER });

    // The new image, plain and unmarked — and the old one's schedule went with it, rather
    // than firing later into a frame that has moved on.
    expect(result.current.src).toBe(OTHER);
    expect(result.current.retrying).toBe(false);
    expect(result.current.failed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  /** The same card again is the same card: a re-render must not restart what is in flight. */
  it("keeps the schedule when the same URL is handed over again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { result, rerender } = retry();

    act(() => result.current.onError());
    await act(async () => void vi.advanceTimersByTime(IMAGE_RETRY_FLOOR_MS - 1));
    rerender({ src: BASE });

    expect(result.current.retrying).toBe(true);
    await act(async () => void vi.advanceTimersByTime(IMAGE_RETRY_SPREAD_MS + 1));
    expect(result.current.src).toBe(`${BASE}?retry=1`);
  });

  /**
   * Nothing to show is not a failure: a deck with no cover has no image to retry, and a hook
   * that scheduled one anyway would sit a "Retrying…" over a frame that is simply empty.
   */
  it("runs no state machine at all when there is no image", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { result } = retry(null);

    expect(result.current.src).toBeNull();
    expect(result.current.retrying).toBe(false);
    expect(result.current.failed).toBe(false);

    act(() => result.current.onError());

    expect(result.current.retrying).toBe(false);
    expect(result.current.failed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
