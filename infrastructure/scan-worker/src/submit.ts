import { LABEL_HEADER } from "./cors";
import { MAX_PENDING, MAX_RUN_BYTES, json, type Env } from "./env";
import { readLabel, type Label } from "./label";

/**
 * `POST /scan` — one scan from the card scanner: the run of frames it was given, and what a
 * reader said they show.
 *
 * **The body is the frames end to end and nothing else**; the label rides in a header
 * (`label.ts`) and its `run` says how long each frame is, which is the only framing there is.
 * So the object in the bucket is the scanner's own bytes: nothing is decoded, re-encoded or
 * unwrapped here, on a plan that gives a request ten milliseconds of CPU, and one cut per entry
 * finds the frames again (`README.md`, *Reading the inbox*).
 *
 * **It is sent as `application/octet-stream`, and `image/jpeg` is refused**: a run of JPEGs is
 * not a JPEG, and the one thing this route must never take is a single picture sent as one.
 */

/** The machine-readable half of each refusal the app words for a reader. */
export const RUN_LIMIT = "run_limit";
export const INBOX_FULL = "inbox_full";

/** How a run is sent, and how it is stored. */
export const RUN_TYPE = "application/octet-stream";

/** `ff d8 ff` — how every JPEG starts, and the whole of the format check, once a frame. */
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

/** What a stored sidecar holds: the label, and the three things only this side knows. */
export interface Sidecar extends Label {
  id: string;
  /** This Worker's clock, never the sender's. */
  received_at: string;
  /** The whole run's length: the sum of its frames', which was held to the body's own. */
  bytes: number;
}

export const runKey = (id: string): string => `runs/${id}.bin`;
export const labelKey = (id: string): string => `labels/${id}.json`;

/**
 * `20261011T101500Z-9f8a…`: the second it arrived and eight random bytes.
 *
 * The time leads so that a listing is in the order things arrived, which is the order they are
 * read in. The random half is there to keep two submissions in one second apart and for nothing
 * else — **an id is not a secret**: no route here answers one, and the app shows it to the reader
 * as the reference a deletion request names.
 */
function mintId(now: number): string {
  const stamp = new Date(now)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const random = crypto.getRandomValues(new Uint8Array(8));
  return `${stamp}-${[...random].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The body, or the size that put it over the cap — `infrastructure/share-worker/src/blob.ts`'s
 * `bounded`. Chunks past the cap are dropped rather than kept, so a caller who lies about
 * `content-length` or omits it cannot make this Worker hold more than the cap.
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
    if (size > MAX_RUN_BYTES && !over) {
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
      error: `that run is ${size} bytes and a scan may be at most ${MAX_RUN_BYTES}`,
      code: RUN_LIMIT,
    },
    413,
  );
}

/**
 * Which frame of the body does not start as a JPEG does, walking the label's lengths — or `null`
 * when every one does. The caller has already held those lengths to the body's own.
 */
function notAJpeg(bytes: Uint8Array, label: Label): number | null {
  let at = 0;
  for (const [index, frame] of label.run.entries()) {
    if (JPEG_MAGIC.some((byte, offset) => bytes[at + offset] !== byte)) return index;
    at += frame.bytes;
  }
  return null;
}

/** How long an isolate goes on answering "full" without asking the bucket again. */
export const FULL_FOR_MS = 60_000;

/**
 * When each bucket was last found full, by this isolate. Keyed on the binding itself, so it is
 * the isolate's own and a test's bucket never answers for another test's.
 *
 * **What it saves is the list.** A list is a billed R2 operation, and once the inbox is full
 * every submission would otherwise buy one only to be refused — which is exactly what a flood
 * against a full inbox is made of. It is a memory of one isolate and no more than a minute long,
 * so an inbox that has been emptied takes scans again within that minute everywhere.
 */
const foundFull = new WeakMap<R2Bucket, number>();

function full(): Response {
  return json(
    { error: "the inbox is full until the scans in it have been read", code: INBOX_FULL },
    503,
  );
}

/**
 * Store one submission, and answer the id it was stored under.
 *
 * **The order is every check that costs nothing, then the body, then the one list.** The content
 * type and the label are facts about the headers, and so is what the label's frames add up to;
 * a declared length past the cap is one too, and is believed only when it refuses; and an inbox
 * this isolate found full under a minute ago is still full.
 *
 * **The body has to be exactly the frames the label lists**: as long as their lengths together,
 * and starting as a JPEG does at every one of them. A body that is one picture under a label
 * that lists five is refused here like any other that does not add up — the label is the index
 * of the bytes, and a wrong index is a run nobody can cut apart.
 *
 * ⚠️ **The inbox is counted after the run has arrived, and never before** — the reverse of what
 * reads as thrifty. Counted first, a sender who sent its headers and held its body back had been
 * let past the cap before it stored a byte, and a thousand of them could be let past a nearly
 * full inbox at once and then all finish. Counted here, what stands between the count and the
 * write is nothing a sender controls.
 *
 * **And what is counted is runs, not labels.** The run is written first and the label last — a
 * write that fails in between leaves a run nobody named, which is litter and not a wrong answer,
 * where a label with no run under it would be the reverse. But the run is the megabytes, so
 * it is the run {@link MAX_PENDING} counts: were it labels, every run whose label never landed
 * would be bytes the cap could not see.
 *
 * **Both writes are handed to the runtime to finish** (`waitUntil`), because a sender who hangs
 * up cancels a request where it stands, and "between the two writes" is a place to stand. Neither
 * write is caught: a 500 that names an unreachable bucket is a better answer than a 201 for
 * something that was not stored.
 *
 * ⚠️ **The count and the write are still two steps, and that is accepted.** Submissions that
 * count in the same instant each store, so the inbox can end a burst holding the cap and that
 * burst; nothing here can make them one step without a Durable Object or a database, which this
 * Worker is deliberately without (`env.ts`). The cap is a bound on a flood, not a ledger. What it
 * must never do is fail to stop, and the next request after the burst is refused.
 */
export async function handleSubmit(
  request: Request,
  env: Env,
  now: number,
  ctx?: ExecutionContext,
): Promise<Response> {
  const type = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (type !== RUN_TYPE) return json({ error: `a scan is sent as ${RUN_TYPE}` }, 415);

  const label = readLabel(request.headers.get(LABEL_HEADER));
  if (typeof label === "string") return json({ error: label }, 400);

  const listed = label.run.reduce((sum, frame) => sum + frame.bytes, 0);
  if (listed > MAX_RUN_BYTES) return tooLarge(listed);

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RUN_BYTES) return tooLarge(declared);

  if (now - (foundFull.get(env.SCANS) ?? -Infinity) < FULL_FOR_MS) return full();

  if (request.body === null) return json({ error: "that request carried no frames" }, 400);
  const { bytes, size } = await bounded(request.body);
  if (bytes === null) return tooLarge(size);
  if (bytes.byteLength !== listed) {
    return json(
      { error: `that run is ${bytes.byteLength} bytes and its label lists ${listed}` },
      400,
    );
  }
  const wrong = notAJpeg(bytes, label);
  if (wrong !== null) return json({ error: `frame ${wrong} of that run is not a JPEG` }, 400);

  const waiting = await env.SCANS.list({ prefix: "runs/", limit: MAX_PENDING });
  if (waiting.truncated || waiting.objects.length >= MAX_PENDING) {
    foundFull.set(env.SCANS, now);
    return full();
  }

  const id = mintId(now);
  const sidecar: Sidecar = {
    ...label,
    id,
    received_at: new Date(now).toISOString(),
    bytes: bytes.byteLength,
  };
  const stored = (async () => {
    await env.SCANS.put(runKey(id), bytes, { httpMetadata: { contentType: RUN_TYPE } });
    await env.SCANS.put(labelKey(id), JSON.stringify(sidecar), {
      httpMetadata: { contentType: "application/json" },
    });
  })();
  // Without a context — the suite — it is simply awaited, as it is with one.
  ctx?.waitUntil(stored);
  await stored;

  return json({ id }, 201);
}
