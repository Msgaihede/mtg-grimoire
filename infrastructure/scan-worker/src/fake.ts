import { LABEL_HEADER } from "./cors";
import type { Env } from "./env";
import type { Label } from "./label";

/**
 * The suite's stand-ins: a bucket, a limiter, a label and a request.
 *
 * There is no workerd here, by `vitest.config.ts`'s deliberate choice, so the handler is a plain
 * function over an injected `Env` and these are what is injected. **The bucket keeps bytes and
 * counts what it was asked**, because half of what this Worker promises is an absence — a refused
 * picture was never stored, a full inbox was not read past — and an absence can only be asserted
 * against something that would have recorded the presence.
 */

export interface Stored {
  bytes: Uint8Array;
  contentType: string | undefined;
}

export interface Inbox {
  env: Env;
  objects: Map<string, Stored>;
  /** Every `list` the handler made, as it was asked. */
  lists: R2ListOptions[];
  /** Every key any limiter was asked about, in order. */
  limited: string[];
}

function bytesOf(value: unknown): Uint8Array {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return new Uint8Array(value);
  throw new Error("the fake bucket was handed something this Worker never stores");
}

/**
 * The Worker's bindings. `allow` is what the limiter answers; `origins` is `APP_ORIGINS`, and
 * `null` leaves the var unset; `waiting` is how many submissions are already in the inbox;
 * `down` makes every write fail, as an unreachable bucket does.
 */
export function inbox(
  options: { allow?: boolean; origins?: string | null; waiting?: number; down?: boolean } = {},
): Inbox {
  const objects = new Map<string, Stored>();
  for (let n = 0; n < (options.waiting ?? 0); n += 1) {
    const id = `20261001T000000Z-${n.toString(16).padStart(16, "0")}`;
    objects.set(`frames/${id}.jpg`, { bytes: new Uint8Array([0xff]), contentType: "image/jpeg" });
    objects.set(`labels/${id}.json`, {
      bytes: new Uint8Array([0x7b, 0x7d]),
      contentType: "application/json",
    });
  }
  const lists: R2ListOptions[] = [];
  const limited: string[] = [];

  const bucket = {
    put(key: string, value: unknown, put?: R2PutOptions) {
      if (options.down === true) return Promise.reject(new Error("R2 is unreachable"));
      const meta = put?.httpMetadata;
      const contentType = meta instanceof Headers ? undefined : meta?.contentType;
      objects.set(key, { bytes: bytesOf(value), contentType });
      return Promise.resolve({});
    },
    list(asked: R2ListOptions = {}) {
      lists.push(asked);
      const keys = [...objects.keys()].filter((key) => key.startsWith(asked.prefix ?? "")).sort();
      const limit = asked.limit ?? 1000;
      return Promise.resolve({
        objects: keys.slice(0, limit).map((key) => ({ key })),
        truncated: keys.length > limit,
      });
    },
  };

  const env: Env = {
    SCANS: bucket as unknown as R2Bucket,
    RL_SUBMIT: {
      limit({ key }: { key: string }) {
        limited.push(key);
        return Promise.resolve({ success: options.allow ?? true });
      },
    },
  };
  if (options.origins !== null) env.APP_ORIGINS = options.origins ?? "https://mtg-grimoire.app";
  return { env, objects, lists, limited };
}

/** A bucket a refused request may not reach: touching it throws. */
export const untouchable = new Proxy(
  {},
  {
    get() {
      throw new Error("the bucket was reached by a request that should have been refused first");
    },
  },
) as unknown as R2Bucket;

/** A whole label, as the engine builds one — Lightning Bolt, Double Masters 2022, in foil. */
export function label(): Label {
  return {
    v: 1,
    card: {
      id: "ce711943-c1a1-43a0-8b89-8d169cfb8e06",
      set: "2x2",
      number: "117",
      lang: "en",
      name: "Lightning Bolt",
    },
    finish: "foil",
    scanner: {
      reported: "f29ba16f-c8fb-42fe-aabf-87089cb214a7",
      mode: "fast",
      confidence: 0.82,
      distance: 31,
      bundle: 98_000,
    },
    app: { version: "0.43.0", platform: "desktop" },
    frame: { width: 1920, height: 1080 },
  };
}

/** A JPEG's first bytes and a little after them. Nothing here decodes one. */
export function jpeg(length = 64): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return bytes;
}

export const ADDRESS = "203.0.113.7";

/**
 * One request to the inbox. Everything defaults to a submission it would take; `null` leaves a
 * header off, and `label` may be any value (it is stringified) or the header's text as it is.
 */
export function scan(
  options: {
    method?: string;
    path?: string;
    label?: unknown;
    labelText?: string | null;
    type?: string | null;
    body?: Uint8Array | null;
    origin?: string;
    headers?: Record<string, string>;
  } = {},
): Request {
  const method = options.method ?? "POST";
  const headers: Record<string, string> = { "cf-connecting-ip": ADDRESS, ...options.headers };
  const type = options.type === undefined ? "image/jpeg" : options.type;
  if (type !== null) headers["content-type"] = type;
  const text =
    options.labelText === undefined
      ? JSON.stringify(options.label === undefined ? label() : options.label)
      : options.labelText;
  if (text !== null) headers[LABEL_HEADER] = text;
  if (options.origin !== undefined) headers.origin = options.origin;

  const carries = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
  const body = options.body === undefined ? jpeg() : options.body;
  return new Request(`https://scans.example${options.path ?? "/scan"}`, {
    method,
    headers,
    body: carries ? body : null,
  });
}
