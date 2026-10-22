/**
 * The scan Worker's bindings, its caps, and the one helper every answer is built with.
 *
 * **This is a fourth Worker rather than a route on one of the other three, and the reason is the
 * share Worker's: blast radius** (`infrastructure/share-worker/src/env.ts`). It binds **one bucket
 * and one limiter**: no D1, no Durable Object, no service binding. A fault here can fill or lose
 * the scans and cannot write a membership, a sync log or a shared binder.
 *
 * **Its write is behind the relay's token, like every other write this project's servers take**
 * (the owner's decision, 2026-10-11: sending a scan is a supporter's). It was first built open
 * to anybody, bounded by its caps alone; `auth.ts` is the door it has now. ⚠️ **That costs this
 * Worker one secret, and it is the one that matters**: `RELAY_HMAC_KEY` signs every sync token,
 * and it is now on three Workers where it was on two. What this one does with it is `verify`
 * and nothing else — it mints nothing, returns no claim and keeps no log — and a change that
 * made it read the key anywhere but `auth.ts` is one to refuse.
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

  /**
   * **The relay's signing key — a secret, and so in no file of this repository.** Set by the
   * owner with `wrangler secret put RELAY_HMAC_KEY`, to the value the relay and the share Worker
   * hold (`README.md`, *Deploying*); a deploy neither reads nor changes it. Optional in the type
   * because a Worker deployed before its secret is set is a state that happens, and `auth.ts`
   * answers it in a sentence — a 500 that names the key — rather than being typed out of
   * existence.
   */
  RELAY_HMAC_KEY?: string;
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
 * Ten megabytes a run, every frame of it together. The app sends the frames its scanner judged
 * at the camera's own resolution, up to 1920 pixels wide (the owner's decision, 2026-10-22: a
 * picture can always be brought down later, never up) — two to four hundred kilobytes each — and
 * keeps a run under eight megabytes; the rest is room, and the ceiling is what makes
 * {@link MAX_PENDING} a bound in bytes as well as in objects.
 *
 * ⚠️ **`scanner_submit::MAX_RUN_BYTES` in the engine is this number**, held the same way.
 */
export const MAX_RUN_BYTES = 10 * 1024 * 1024;

/**
 * Two hundred runs waiting to be read, and then the inbox is full until it is emptied.
 *
 * **This is the bound on what the inbox can be made to store**: 200 × 10 MB is about two
 * gigabytes against R2's free ten, whoever is sending and however many addresses they send from.
 * (It was 500 × 2 MB while a run was the scanner's small frames; the runs grew five times and
 * the count came down to keep the bound near where it was.)
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
export const MAX_PENDING = 200;

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
