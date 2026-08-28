import type { LinkReading } from "@/pwa/connection";

export type FeedId = "corpus" | "combos" | "card-kingdom";

export interface FeedSize {
  /** Compressed bytes over the wire, or `null` when it cannot be known. */
  bytes: number | null;
  /** The feed said so, rather than this app inferring it. */
  exact: boolean;
}

/** Spec §5.3: "any feed over 5 MB". Decimal MB, matching `useUpdate`'s `formatBytes`. */
export const PROMPT_OVER_BYTES = 5_000_000;

const UNKNOWN: FeedSize = { bytes: null, exact: false };

/** What each feed is called on the dialog. */
export const FEED_NAME: Record<FeedId, string> = {
  corpus: "the card database",
  combos: "the combo database",
  "card-kingdom": "the Card Kingdom price list",
};

/**
 * One probe per feed per session.
 *
 * **Two requests per refresh is what Scryfall's rule allows and no more**: this probe and the
 * download's own descriptor read are separated by a human press, which is far more than the
 * 50–100 ms the API asks for. Asking again on every press would not be.
 *
 * A *failure* is deliberately not cached — a network that was down a moment ago may be up now,
 * and an unknown size is the one case that always prompts, so caching it would ask about that
 * feed forever.
 */
const cache = new Map<FeedId, FeedSize>();

/** For the suite. Nothing in the app calls this: the cache is a session. */
export function clearFeedSizeCache(): void {
  cache.clear();
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * What this feed will cost, from the feed itself.
 *
 * **A page `fetch` rather than a new Rust command, and that is a bounded exception to "facts are
 * Rust's".** The prompt exists only on the web target, where the shell already fetches on its own
 * account, and both hosts send `Access-Control-Allow-Origin: *` (verified in the spike, and it is
 * what makes the whole web target possible). The alternative is a `feed_download_size` command —
 * five files of new surface across `src-tauri/`, `ipc.ts`, its DTO, its argument pin and the
 * Storybook fake — landing in the same week PR 4 is rewriting the Rust I/O layer.
 *
 * **Android will need the Rust one.** A Tauri webview runs under `default-src 'self'` and cannot
 * fetch Scryfall from the page at all. **This file is the single place that changes**; it is
 * named here so PR 8 does not have to find it.
 */
export async function probeFeedSize(feed: FeedId, fetchFn: Fetcher): Promise<FeedSize> {
  const hit = cache.get(feed);
  if (hit) return hit;
  const size = await probe(feed, fetchFn).catch(() => UNKNOWN);
  if (size.bytes !== null) cache.set(feed, size);
  return size;
}

async function probe(feed: FeedId, fetchFn: Fetcher): Promise<FeedSize> {
  if (feed === "corpus") {
    // `compressed_size` is the field the app's own `scryfall.rs` reads (`BulkInfo`), so the
    // prompt shows the same number the download will report.
    const response = await fetchFn("https://api.scryfall.com/bulk-data/default_cards", {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return UNKNOWN;
    const body = (await response.json()) as { compressed_size?: number };
    return typeof body.compressed_size === "number"
      ? { bytes: body.compressed_size, exact: true }
      : UNKNOWN;
  }

  if (feed === "combos") {
    // Verified live 2026-08-28: `Content-Length: 27558428`, `Content-Encoding: gzip`,
    // `Accept-Ranges: bytes`. The spike measured 27 555 788 the day before, which is the file
    // being rebuilt and not a discrepancy.
    const response = await fetchFn("https://json.commanderspellbook.com/variants.json.gz", {
      method: "HEAD",
    });
    if (!response.ok) return UNKNOWN;
    const length = Number(response.headers.get("content-length"));
    return Number.isFinite(length) && length > 0 ? { bytes: length, exact: true } : UNKNOWN;
  }

  // Card Kingdom. **No probe at all, and the absence is the answer.** Verified live 2026-08-28:
  // a HEAD on `api.cardkingdom.com/api/v2/pricelist` answers 200 with `Content-Type: text/html`
  // and no `Content-Length`, and the feed is paginated, so there is no single number to read.
  // The price research measured 66 787 283 B uncompressed in August — real, and exactly the
  // kind of measured-once figure that rots into a lie if it is reprinted as a promise.
  return UNKNOWN;
}

export interface PromptDecision {
  show: boolean;
  /** Which button opens focused. */
  preferred: "download" | "not-now";
}

/**
 * Whether to ask, and which way to lean.
 *
 * **An unknown size always asks**, which is the one place this errs towards the interruption:
 * not asking about a download nobody can size is the reckless answer, and the Card Kingdom feed
 * is the case it was written for.
 */
export function shouldPrompt(size: FeedSize, link: LinkReading): PromptDecision {
  const show = size.bytes === null || size.bytes > PROMPT_OVER_BYTES;
  return { show, preferred: link.metered ? "not-now" : "download" };
}
