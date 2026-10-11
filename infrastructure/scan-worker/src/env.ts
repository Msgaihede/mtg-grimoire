/**
 * The scan Worker's bindings, its caps, and the one helper every answer is built with.
 *
 * **This is a fourth Worker rather than a route on one of the other three, and the reason is the
 * share Worker's: blast radius** (`infrastructure/share-worker/src/env.ts`). Every other write this
 * project's servers take is behind a token the relay minted, which is behind a membership. This one
 * is behind nothing — a reader who scans cards is not asked to pay to say the scanner was wrong —
 * so it is the one route on the account a stranger can make store bytes. It therefore binds **one
 * bucket and one limiter and holds no secret**: no D1, no signing key, no Durable Object. A fault
 * here can fill or lose the scans and cannot reach a membership, a sync log or a shared binder.
 *
 * **Nothing is ever read back out through this Worker.** There is no `GET` for a run or a label:
 * the maker reads the bucket with his own credentials (`README.md`, *Reading the inbox*). An upload
 * route that also served what it took would be free image hosting for whoever found it.
 */
export interface Env {
  /**
   * The inbox. One submission is two objects: `runs/{id}.bin`, the run's frames end to end and
   * byte for byte as they were sent, and `labels/{id}.json`, what a reader said they show and
   * where each frame is in the first (`label.ts`).
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
 * The fewest frames that are a scan, and the most.
 *
 * **A scan is a run of frames and never one picture** — the maker's rule for the whole feature.
 * The scanner decides over a run, so one frame cannot say what it did; a submission of fewer
 * than {@link MIN_RUN_FRAMES} is refused whole (`label.ts`), and there is no second shape that
 * takes a single still. Twenty is about two seconds of the app's pump.
 *
 * ⚠️ **The engine's `scanner_submit::{MIN_RUN_FRAMES, MAX_RUN_FRAMES}` are these numbers**, so a
 * run this Worker would refuse is refused in a sentence before it is sent. `wrangler.test.ts`
 * reads the Rust and holds them together.
 */
export const MIN_RUN_FRAMES = 5;
export const MAX_RUN_FRAMES = 20;

/**
 * Two megabytes a run, every frame of it together. The app sends the frames its scanner was
 * given — JPEGs some 960 pixels on their long edge, forty to ninety kilobytes each — and keeps a
 * run under a megabyte and a half; the rest is room, and the ceiling is what makes
 * {@link MAX_PENDING} a bound in bytes as well as in objects.
 *
 * ⚠️ **`scanner_submit::MAX_RUN_BYTES` in the engine is this number**, held the same way.
 */
export const MAX_RUN_BYTES = 2 * 1024 * 1024;

/**
 * Five hundred runs waiting to be read, and then the inbox is full until it is emptied.
 *
 * **This is the bound on what a stranger can make the account store**: 500 × 2 MB is about a
 * gigabyte against R2's free ten, whoever is sending and however many addresses they send from.
 * A rate limit cannot be that bound — it is per address and, measured on the relay, far looser
 * than its number reads. The price is that a flood can fill the inbox and turn honest readers
 * away with a sentence until the maker empties it, which is the right way round: a full inbox
 * costs a few scans, an unbounded one costs money.
 *
 * It is counted by listing `runs/` — one list a submission, no counter to drift — and it is one
 * page of a list exactly (`limit` takes at most 1000). **Runs and not labels**, because the run
 * is the bytes: `submit.ts` has why, and why "about" — the count and the write are two steps,
 * so a burst that counts in one instant can leave the inbox holding the cap and itself.
 */
export const MAX_PENDING = 500;

/**
 * The label's header, in characters. A real one is some four thousand — twenty frames' figures
 * are most of it — and this is room for the longest card name there is beside them, and nothing
 * that could be called a second payload.
 *
 * ⚠️ **`scanner_submit::MAX_LABEL_CHARS` in the engine is this number**, held the same way: the
 * engine bounds every field that could run on and refuses a label past this in the reader's
 * sentence, so that this side's refusal is never the one a reader meets.
 */
export const MAX_LABEL_CHARS = 8192;

/** `infrastructure/share-worker/src/env.ts`'s five lines, copied for the reason that file gives. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
