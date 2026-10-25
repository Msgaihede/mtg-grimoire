/**
 * A projection's two bounds (plan §3.2): **eight megabytes as sent, gzipped, and twenty-four
 * inflated** — both refused as `413 projection_limit`, both counted rather than believed.
 *
 * **Twenty-four inflated is sized by the largest document measured, and by what one isolate can
 * hold.** A 50,000-card `collection_entries` under every field on measured 15.1 MiB of JSON
 * (`test/measure.test.ts`, rows shaped as the Rust projects them), so twenty-four is that and half
 * again. A Worker or an object has 128 MB, the inflated text is held once as a
 * string while `JSON.parse` builds several times its size in objects beside it, so a cap much past
 * this is a document that kills the isolate before it can be refused — sixty-four, the first cap,
 * did exactly that (60 MiB of gzipped spaces reached 128 MiB of buffers before a byte was parsed:
 * the review of 2026-10-25). A body that inflates past it is a collection far past anything
 * measured, or a gzip bomb, and both get the same refusal.
 *
 * Eight as sent is eight times that document gzipped (~1 MB), and the share Worker's cap
 * (`infrastructure/share-worker/src/env.ts`'s `MAX_BLOB_BYTES`). Projections gzip about fifteen to
 * one, so the inflated cap is the one a real collection meets first.
 */

/** Eight megabytes of gzip, as the request carries it. */
export const MAX_GZIP_BYTES = 8 * 1024 * 1024;

/** Twenty-four mebibytes of JSON, once inflated. */
export const MAX_INFLATED_BYTES = 24 * 1024 * 1024;

/** `1f 8b` — the two bytes every gzip member starts with. */
const GZIP_MAGIC = [0x1f, 0x8b];

/**
 * The bytes a stream carries, or the count that put it over `cap`. **Chunks past the cap are
 * dropped rather than kept**, so a body that lies about its `content-length`, or has none, never
 * makes this hold more than the cap — `blob.ts`'s `bounded` in the share Worker, with the cap a
 * parameter. Counting goes on past it so the refusal can name the real size; a gzip stream that
 * is being inflated is cancelled instead (`inflate`), because there the count is unbounded.
 */
export async function bounded(
  body: ReadableStream<Uint8Array>,
  cap: number,
): Promise<{ bytes: Uint8Array | null; size: number }> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let over = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done === true || value === undefined) break;
    size += value.byteLength;
    if (size > cap && !over) {
      over = true;
      chunks.length = 0;
    }
    if (!over) chunks.push(value);
  }
  return over ? { bytes: null, size } : { bytes: join(chunks, size), size };
}

function join(chunks: Uint8Array[], size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/** What inflating a body came to: the JSON's text, a body over the cap, or one that is not gzip. */
export type Inflated = { text: string } | { over: true } | { bad: true };

/**
 * `gz` inflated and decoded, under a counted cap. **The stream is cancelled the moment the count
 * passes the cap**, so a bomb costs this object at most the cap and the chunk that crossed it —
 * not the whole expansion.
 *
 * **Each chunk is decoded as it arrives and let go** (a streaming `TextDecoder`), so the inflated
 * bytes are never held whole: what this keeps is the text, which `JSON.parse` needs anyway. Until
 * the review of 2026-10-25 it kept every chunk, joined them into a second copy, and decoded a third
 * — three times the document before the parse began.
 *
 * A body that does not start with gzip's magic, that the decompressor refuses part way, or that is
 * not UTF-8 is `bad`; one that ends early is too (the decompressor errors on a truncated member,
 * which is what makes a cut-off upload a refusal rather than a short table).
 */
export async function inflate(gz: Uint8Array, cap = MAX_INFLATED_BYTES): Promise<Inflated> {
  if (gz.byteLength < 2 || gz[0] !== GZIP_MAGIC[0] || gz[1] !== GZIP_MAGIC[1]) return { bad: true };
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(gz);
      controller.close();
    },
  });
  const reader = source.pipeThrough(new DecompressionStream("gzip")).getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  const parts: string[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done === true || value === undefined) break;
      size += value.byteLength;
      if (size > cap) {
        await reader.cancel().catch(() => undefined);
        return { over: true };
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
  } catch {
    return { bad: true };
  }
  return { text: parts.join("") };
}
