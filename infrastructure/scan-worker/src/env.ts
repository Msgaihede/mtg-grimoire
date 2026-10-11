/**
 * The scan Worker's bindings, its three caps, and the one helper every answer is built with.
 *
 * **This is a fourth Worker rather than a route on one of the other three, and the reason is the
 * share Worker's: blast radius** (`infrastructure/share-worker/src/env.ts`). Every other write this
 * project's servers take is behind a token the relay minted, which is behind a membership. This one
 * is behind nothing — a reader who scans cards is not asked to pay to say the scanner was wrong —
 * so it is the one route on the account a stranger can make store bytes. It therefore binds **one
 * bucket and one limiter and holds no secret**: no D1, no signing key, no Durable Object. A fault
 * here can fill or lose the scans and cannot reach a membership, a sync log or a shared binder.
 *
 * **Nothing is ever read back out through this Worker.** There is no `GET` for a frame or a label:
 * the maker reads the bucket with his own credentials (`README.md`, *Reading the inbox*). An upload
 * route that also served what it took would be free image hosting for whoever found it.
 */
export interface Env {
  /**
   * The inbox. One submission is two objects: `frames/{id}.jpg`, the picture byte for byte as it
   * was sent, and `labels/{id}.json`, what a reader said it shows (`label.ts`).
   */
  SCANS: R2Bucket;

  /**
   * The limiter in front of the route, **optional because its absence is handled and not assumed
   * away** — `infrastructure/relay/src/ratelimit.ts`'s rule: a limiter that is missing or throws
   * lets the request through. What bounds the bucket is {@link MAX_PENDING}, which needs no
   * binding; this bounds how fast one address can reach it.
   */
  RL_SUBMIT?: RateLimit;

  /**
   * The origins a browser may ask from, comma-separated — `wrangler.jsonc`'s `vars`, shipped as
   * exactly the web app's. `cors.ts` is the reasoning, and unset it lets nobody's browser in.
   */
  APP_ORIGINS?: string;
}

/**
 * Two megabytes a picture. The app sends a JPEG no longer than 1920 pixels on its long edge
 * (`packages/ui/features/scanner/submit/still.ts`), which a camera's frame fills to well under
 * half of this; the rest is room, and the ceiling is what makes {@link MAX_PENDING} a bound in
 * bytes as well as in objects.
 *
 * ⚠️ **`scanner_submit::MAX_FRAME_BYTES` in the engine is this number**, so that a picture this
 * Worker would refuse is refused in a sentence before it is sent. `wrangler.test.ts` reads the
 * Rust and holds the two together.
 */
export const MAX_FRAME_BYTES = 2 * 1024 * 1024;

/**
 * Five hundred pictures waiting to be read, and then the inbox is full until it is emptied.
 *
 * **This is the bound on what a stranger can make the account store**: 500 × 2 MB is about a
 * gigabyte against R2's free ten, whoever is sending and however many addresses they send from.
 * A rate limit cannot be that bound — it is per address and, measured on the relay, far looser
 * than its number reads. The price is that a flood can fill the inbox and turn honest readers
 * away with a sentence until the maker empties it, which is the right way round: a full inbox
 * costs a few scans, an unbounded one costs money.
 *
 * It is counted by listing `frames/` — one list a submission, no counter to drift — and it is one
 * page of a list exactly (`limit` takes at most 1000). **Pictures and not labels**, because the
 * picture is the bytes: `submit.ts` has why, and why "about" — the count and the write are two
 * steps, so a burst that counts in one instant can leave the inbox holding the cap and itself.
 */
export const MAX_PENDING = 500;

/**
 * The label's header, in characters. A real one is some four hundred; this is room for the
 * longest card name there is and nothing that could be called a second payload.
 */
export const MAX_LABEL_CHARS = 2048;

/** `infrastructure/share-worker/src/env.ts`'s five lines, copied for the reason that file gives. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
