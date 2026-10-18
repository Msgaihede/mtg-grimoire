import { mint } from "@grimoire/relay/src/token";
import { LABEL_HEADER } from "./cors";
import type { Env } from "./env";
import type { Frame, Label } from "./label";

/**
 * The suite's stand-ins: a bucket, a limiter, a label, a run and a request.
 *
 * There is no workerd here, by `vitest.config.ts`'s deliberate choice, so the handler is a plain
 * function over an injected `Env` and these are what is injected. **The bucket keeps bytes and
 * counts what it was asked**, because half of what this Worker promises is an absence — a refused
 * run was never stored, a full inbox was not read past — and an absence can only be asserted
 * against something that would have recorded the presence.
 */

/** The suite's signing key: what the relay and this Worker would both hold. Not a secret. */
export const KEY = "a-test-signing-key";

/** A token of the relay's for a supporter's device, signed with `key` and dying at `exp`. */
export const tokenFor = (exp: number, key: string = KEY): Promise<string> =>
  mint({ sub: "patreon-user-1", grp: "a-sync-group-id", exp, dev: "a-device-id" }, key);

/**
 * A live token, minted once for the module: good until the year 2100, so a test that moves the
 * clock stays inside it. {@link scan} sends it unless it is told otherwise — every request the
 * suite makes is a supporter's by default, so a test about a label or a body is about that.
 */
export const TOKEN = await tokenFor(Date.UTC(2100, 0, 1));

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
 * `down` makes every write fail, as an unreachable bucket does; `key` is `RELAY_HMAC_KEY`, and
 * `null` leaves the secret unset, as a Worker deployed before its secret is.
 */
export function inbox(
  options: {
    allow?: boolean;
    origins?: string | null;
    waiting?: number;
    down?: boolean;
    key?: string | null;
  } = {},
): Inbox {
  const objects = new Map<string, Stored>();
  for (let n = 0; n < (options.waiting ?? 0); n += 1) {
    const id = `20261001T000000Z-${n.toString(16).padStart(16, "0")}`;
    objects.set(`runs/${id}.bin`, {
      bytes: new Uint8Array([0xff]),
      contentType: "application/octet-stream",
    });
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
  if (options.key !== null) env.RELAY_HMAC_KEY = options.key ?? KEY;
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

/** One frame's entry, `ms` before the press and `bytes` long, that the scanner made nothing of. */
export function frame(ms: number, bytes: number, over: Partial<Frame> = {}): Frame {
  return {
    ms,
    bytes,
    width: 960,
    height: 540,
    ok: false,
    lock: null,
    confidence: null,
    distance: null,
    decided: null,
    detail: false,
    ...over,
  };
}

/**
 * A whole label, as the engine builds one — Lightning Bolt, Double Masters 2022, in foil, over
 * the fewest frames that are a run: nothing found, a lock being taken, and the frame it was
 * decided on. **Every frame is a different length**, so a body cut at the wrong place is a body
 * some test can tell from the right one.
 */
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
      filters: { sets: ["2x2", "lea"], from: null, to: "2022-07-08" },
    },
    app: { version: "0.43.0", platform: "desktop" },
    run: [
      frame(-440, 64),
      frame(-330, 80, { ok: true, lock: "acquiring", distance: 44 }),
      frame(-220, 72, { ok: true, lock: "acquiring", distance: 44 }),
      frame(-110, 96, { ok: true, lock: "locked", confidence: 0.413, distance: 31, detail: true }),
      frame(0, 68, {
        ok: true,
        lock: "locked",
        confidence: 0.82,
        distance: 31,
        decided: "f29ba16f-c8fb-42fe-aabf-87089cb214a7",
      }),
    ],
  };
}

/** A JPEG's first bytes and a little after them. Nothing here decodes one. */
export function jpeg(length = 64): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set([0xff, 0xd8, 0xff, 0xe0].slice(0, length));
  return bytes;
}

/**
 * The body a list of frames describes: a JPEG's beginning at each one, as long as its entry says,
 * end to end. Each frame's fifth byte is its place in the run, so a frame out of order — or a
 * body stored as anything but what was sent — is told apart byte for byte.
 */
export function frames(run: readonly { bytes: number }[] = label().run): Uint8Array {
  const body = new Uint8Array(run.reduce((sum, entry) => sum + entry.bytes, 0));
  let at = 0;
  for (const [index, entry] of run.entries()) {
    body.set(jpeg(entry.bytes), at);
    if (entry.bytes > 4) body[at + 4] = index + 1;
    at += entry.bytes;
  }
  return body;
}

/** `label()` over `lengths`, one frame each and the last one at the press. */
export function labelOver(lengths: readonly number[]): Label {
  return {
    ...label(),
    run: lengths.map((bytes, at) => frame(-110 * (lengths.length - 1 - at), bytes)),
  };
}

/** The lengths a sent label lists, when it lists any — for the body {@link scan} sends by default. */
function listed(sent: unknown): { bytes: number }[] | null {
  const run = (sent as { run?: unknown } | null)?.run;
  if (!Array.isArray(run)) return null;
  const entries = run as unknown[];
  const whole = entries.every(
    (entry): entry is { bytes: number } =>
      typeof entry === "object" &&
      entry !== null &&
      Number.isInteger((entry as { bytes?: unknown }).bytes) &&
      (entry as { bytes: number }).bytes >= 0 &&
      // A length no test means to allocate: such a label is refused before its body matters.
      (entry as { bytes: number }).bytes <= 4 * 1024 * 1024,
  );
  return whole ? entries : null;
}

export const ADDRESS = "203.0.113.7";

/**
 * One request to the inbox. Everything defaults to a submission it would take — a supporter's,
 * carrying {@link TOKEN}; `null` leaves a header off, and `label` may be any value (it is stringified) or the header's text as it is.
 * **The body defaults to the frames the label lists**, so a test that changes a label's run and
 * says nothing of the body is still a submission that adds up.
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
    /** The bearer token; `null` sends no `authorization` at all. A supporter's by default. */
    token?: string | null;
    headers?: Record<string, string>;
  } = {},
): Request {
  const method = options.method ?? "POST";
  const headers: Record<string, string> = { "cf-connecting-ip": ADDRESS };
  const token = options.token === undefined ? TOKEN : options.token;
  if (token !== null) headers.authorization = `Bearer ${token}`;
  Object.assign(headers, options.headers);
  const type = options.type === undefined ? "application/octet-stream" : options.type;
  if (type !== null) headers["content-type"] = type;
  const text =
    options.labelText === undefined
      ? JSON.stringify(options.label === undefined ? label() : options.label)
      : options.labelText;
  if (text !== null) headers[LABEL_HEADER] = text;
  if (options.origin !== undefined) headers.origin = options.origin;

  const carries = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
  const body =
    options.body === undefined ? frames(listed(options.label) ?? undefined) : options.body;
  return new Request(`https://scans.example${options.path ?? "/scan"}`, {
    method,
    headers,
    body: carries ? body : null,
  });
}
