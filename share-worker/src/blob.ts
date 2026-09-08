import { MAX_BLOB_BYTES, json, type Env } from "./env";
import { UNAVAILABLE, WITHDRAWN } from "./page";
import { LAPSED, publicShare, REVOKED } from "./shares";

/**
 * The snapshot itself: the gated `PUT` that stores one, and the public `GET` that serves it.
 *
 * **`shares.ts` owns the metadata columns and this file owns the two the blob writes** —
 * `object_key` and `bytes`. The split is the two-step that makes a failed upload harmless
 * (spec §4.1): `handleCreate` writes a row whose `object_key` is NULL and answers a link, and
 * nothing points that column at an object until the object is in R2. A publish that dies in
 * between leaves either *no* snapshot or the *previous* snapshot, and never a link to something
 * that was never written.
 *
 * **R2 rather than D1, KV or a Durable Object** (spec §5.3), and the last of those is the one
 * that matters here: a Durable Object is the line that meters, and this is the file anonymous
 * traffic reaches.
 */

/**
 * The machine-readable half of the size refusal, for `share_limit`'s reason: 413 already means
 * other things, the sentence is copy that is meant to be improvable, and the app has to branch on
 * *something* that will not move when somebody rewords it.
 */
const BLOB_LIMIT = "blob_limit";

/** `1f 8b` — the two bytes every gzip member starts with, and the whole of the format check. */
const GZIP_MAGIC = [0x1f, 0x8b];

/** `shares/{id}/{hash}.json.gz` — spelled once, because the public route rebuilds it to compare. */
function objectKey(id: string, hash: string): string {
  return `shares/${id}/${hash}.json.gz`;
}

/**
 * The first sixteen hex characters of the body's SHA-256 — 64 bits, which is the whole of what
 * content-addressing needs here.
 *
 * It is a *cache* key rather than a security boundary: the id beside it is already 96 unguessable
 * bits and is the only credential a viewer has, so a collision would at worst let one share's
 * snapshot answer for another of the **same** share's, and only if somebody could produce two
 * gzip files with a colliding prefix and get the owner to publish both. A full 64-character key
 * would buy nothing and would go into every link the viewer preloads.
 */
async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

/**
 * The body, or the size that put it over the cap.
 *
 * ⚠️ **This buffers, and the brief's "stream `request.body` straight into R2" is not available.**
 * The key is content-addressed, so the digest has to be known *before* the object can be named,
 * and R2's Workers binding has no rename or server-side copy to fix that afterwards. The choices
 * were therefore: buffer once, bounded by the cap; or write to a temporary key, read it back and
 * write it again under the real one, which is three R2 operations and two more failure modes for
 * a document the cap holds to eight megabytes. This is the first.
 *
 * **What it does keep from streaming is the bound.** Chunks past the cap are dropped rather than
 * accumulated, so a caller who lies about `content-length` — or omits it — cannot make this
 * Worker hold more than the cap however much it sends. Counting continues past that point on
 * purpose: the refusal names the real size, which is the difference between *"your snapshot is
 * 9.4 MB and the limit is 8"* and *"too big"*. The loop is bounded by the platform's own request
 * body limit, not by patience.
 */
async function bounded(
  body: ReadableStream<Uint8Array>,
): Promise<{ bytes: Uint8Array | null; size: number }> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let over = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done === true || value === undefined) break;
    size += value.byteLength;
    if (size > MAX_BLOB_BYTES && !over) {
      over = true;
      chunks.length = 0;
    }
    if (!over) chunks.push(value);
  }
  if (over) return { bytes: null, size };

  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return { bytes, size };
}

function tooLarge(size: number): Response {
  return json(
    {
      error:
        `that snapshot is ${size} bytes and a share may be at most ${MAX_BLOB_BYTES}. ` +
        `Share a folder rather than the whole collection, or leave out the optional fields.`,
      code: BLOB_LIMIT,
    },
    413,
  );
}

// ---------------------------------------------------------------------------------------
// PUT /g/{group}/share/{id}
// ---------------------------------------------------------------------------------------

/**
 * Store a snapshot against a share this group already owns, and answer the hash the link is
 * built from.
 *
 * **The order is `handleCreate`'s: every check that costs nothing, then the ones that cost.** The
 * row is read first because it is what says the caller owns this share at all — the gate proved
 * only that they hold *a* group's token, and a share id is a **public** string printed in every
 * link, so without `AND group_id = ?` any entitled caller could overwrite anyone's binder with
 * their own bytes. Then `content-length`, which is free. Only then is the body read.
 *
 * **A revoked share is a 404 and not a 410 here**, unlike on the public side: `handleList` does
 * not return revoked rows, so from the owner's device that share has already left, and telling a
 * publisher "gone" about something they cannot see is a distinction with nothing behind it. The
 * `state <> 'revoked'` in the lookup is also what stops a withdrawn link from being quietly
 * re-armed by an upload.
 *
 * **A lapsed share still accepts one**, deliberately: spec §6 puts the flip back to `live` in the
 * daily pass that reads what the relay already decided, so a Worker that re-lit a link because
 * the caller held a token would be a second opinion about when a membership ended.
 *
 * **An R2 failure is not caught**, for `handleCreate`'s reason about a write that was not the
 * race: a 500 naming an unreachable bucket is a far better answer than a 200 pointing at nothing,
 * and D1 is untouched, so the previous snapshot goes on serving and the reader's link still
 * resolves — which is exactly what spec §10 promises for an upload that dies mid-`PUT`.
 */
export async function handleUpload(
  request: Request,
  env: Env,
  group: string,
  id: string,
  now: number,
): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT object_key FROM shares WHERE id = ? AND group_id = ? AND state <> ?`,
  )
    .bind(id, group, REVOKED)
    .first<{ object_key: string | null }>();
  if (row === null) return json({ error: "no such share" }, 404);

  // Declared before measured: a `content-length` past the cap is a fact about the headers, and
  // reading eight megabytes to reach the same refusal is the cost this avoids. It is not trusted
  // — `bounded` catches a body that is bigger than it claimed — it is only believed when it
  // refuses.
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BLOB_BYTES) return tooLarge(declared);

  if (request.body === null) return json({ error: "that request carried no snapshot" }, 400);
  const { bytes, size } = await bounded(request.body);
  if (bytes === null) return tooLarge(size);

  // ⚠️ **The public route nails `content-encoding: gzip` onto whatever this stored**, so a body
  // that is not gzip does not fail here — it fails in every viewer's browser, as a decoding error
  // with nothing pointing back at the upload that caused it.
  if (bytes.byteLength < 2 || bytes[0] !== GZIP_MAGIC[0] || bytes[1] !== GZIP_MAGIC[1]) {
    return json({ error: "that is not a gzipped snapshot" }, 400);
  }

  const hash = await digest(bytes);
  const key = objectKey(id, hash);
  await env.SHARES.put(key, bytes);

  await env.DB.prepare(
    `UPDATE shares SET object_key = ?, bytes = ?, updated_at = ? WHERE id = ? AND group_id = ?`,
  )
    .bind(key, bytes.byteLength, now, id, group)
    .run();

  // **After the row has moved, and only when the key actually changed.** R2 deletes are free and
  // an orphaned object is cheaper than a missing one, so the ordering is not a nicety — a delete
  // before the update would leave a window in which the row points at nothing. And a republish of
  // an *unchanged* collection is content-addressed to the same key: a delete that skipped this
  // comparison would erase the object it had just written, leaving every link 404ing while the
  // row pointed confidently at it.
  if (row.object_key !== null && row.object_key !== key) await env.SHARES.delete(row.object_key);

  return json({ hash });
}

// ---------------------------------------------------------------------------------------
// GET /s/{id}/{hash}.json.gz
// ---------------------------------------------------------------------------------------

/**
 * `caches.default`, or nothing at all.
 *
 * The suite runs in jsdom, where `caches` does not exist — the cache is workerd's, and this Worker
 * has no test runner for workerd by `vite.config.ts`'s deliberate choice. The `undefined` branch
 * is therefore reachable in tests and never in production, which is the same shape
 * `swCore.ts`/`sw.ts` splits along.
 */
function edgeCache(): Cache | undefined {
  return typeof caches === "undefined" ? undefined : caches.default;
}

/**
 * Serve one snapshot, to anybody holding the link.
 *
 * **Immutable for a year, and the path is why it can be**: the file name is the digest of its own
 * contents, so a republish is a different URL rather than a changed one and no viewer can be
 * handed a stale body under a live name.
 *
 * ⚠️ **What `immutable` costs is that a revocation cannot recall an edge copy.** Somebody whose
 * browser or CDN node already holds this exact URL keeps it. What revoking does stop is every
 * *new* viewer: the shell is the only thing that hands out this URL, it is `max-age=300`, and it
 * answers 410 the moment the row moves. The alternative — a short max-age on an eight-megabyte
 * body — would put the whole snapshot back on R2's budget for every reader who reloads.
 *
 * **`caches.default` in front of R2** so a warm view costs no storage read at all. It cannot help
 * with spec §7.1's real ceiling, which is the free plan's per-*account* request budget; nothing
 * in this Worker can.
 */
export async function handleSnapshot(
  request: Request,
  env: Env,
  id: string,
  hash: string,
  ctx?: ExecutionContext,
): Promise<Response> {
  const cache = edgeCache();
  // Before the D1 read and not after it: a cache that sat behind the lookup would still spend a
  // row read on every view, which is the budget this is here to protect.
  const hit = await cache?.match(request);
  if (hit !== undefined) return hit;

  const row = await publicShare(env, id);
  if (row === null) return json({ error: "no such share" }, 404);
  if (row.state === REVOKED) return json({ error: WITHDRAWN }, 410);
  if (row.state === LAPSED) return json({ error: UNAVAILABLE }, 410);

  // ⚠️ **The row decides which object may be served, not the URL.** Without this comparison a
  // superseded hash would be a live path for as long as the object survived, and revoking a share
  // would be undone by anyone who had kept an older link.
  const key = objectKey(id, hash);
  if (row.object_key !== key) return json({ error: "no such snapshot" }, 404);

  const object = await env.SHARES.get(key);
  if (object === null) return json({ error: "no such snapshot" }, 404);

  const response = new Response(object.body, {
    headers: {
      "content-type": "application/json",
      "content-encoding": "gzip",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });

  // `waitUntil` where there is one — writing an eight-megabyte body into the cache must not sit
  // between R2 and the reader. Without a context (the suite) it is awaited instead, so a test can
  // assert the second view costs no read.
  const stored = cache?.put(request, response.clone());
  if (stored !== undefined) {
    if (ctx === undefined) await stored;
    else ctx.waitUntil(stored);
  }
  return response;
}
