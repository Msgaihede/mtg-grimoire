import type { BotNamespace } from "./rpc";

/**
 * The Discord front's bindings and the helpers every answer is built with.
 *
 * **A Worker of its own, beside the relay, the share Worker, the scan inbox and the web app's
 * hosting, for their reason: blast radius** (`infrastructure/share-worker/src/env.ts`). It is the
 * one that talks to the most strangers — Discord on every keystroke of an autocomplete, a browser
 * on every sign-in — and a bad deploy here must not be a sync outage.
 *
 * **It holds no sync key** (the design, §9 and §13.1). The bot is a device in the reader's sync
 * group, and its identity, the group key and the materialised database live in a Durable Object
 * of another script (`mtg-grimoire-bot-device`), one per link, which this Worker reaches through
 * `BOT` and nothing else. What this Worker keeps is who is linked to which Durable Object — the
 * relay's D1, two tables of its own — and it answers `/card-search` itself, from Scryfall, since
 * that command reads nobody's data.
 */
export interface Env {
  /**
   * **The relay's D1 database** (`mtg-grimoire-relay`), for this Worker's two tables:
   * `discord_link_requests` and `discord_links` (`migrations/0001_discord-links.sql`). It reads
   * none of the relay's or the share Worker's.
   */
  DB: D1Database;

  /** The bot's Durable Objects (`rpc.ts`): one per linked Discord account. */
  BOT: BotNamespace;

  /**
   * The limiter in front of `POST /link/begin`, the one route a stranger reaches that writes a
   * row with nothing to show for it. **Optional because its absence is handled and not assumed
   * away** — `infrastructure/relay/src/ratelimit.ts`'s rule: a limiter that is missing or throws
   * lets the request through.
   */
  RL_BEGIN?: RateLimit;

  /** This Worker's own address, no trailing slash — `wrangler.jsonc`'s `vars`. */
  DISCORD_BASE: string;

  /**
   * The Discord application's id and its Ed25519 public key, as hex. **Public, and so `vars`**:
   * Discord prints both on the application's page. Placeholders until the owner creates the
   * application, and {@link configured} answers 503 to every route until both are real.
   */
  DISCORD_APPLICATION_ID: string;
  DISCORD_PUBLIC_KEY: string;

  /**
   * **The application's OAuth2 client secret — a secret, and so in no file of this repository.**
   * Set by the owner with `wrangler secret put DISCORD_CLIENT_SECRET`. Read by `link.ts` alone,
   * to exchange a sign-in's code; optional in the type because a Worker deployed before its
   * secret is set is a state that happens, and the link routes answer it in a sentence.
   */
  DISCORD_CLIENT_SECRET?: string;
}

/** A Discord snowflake: an id is a decimal integer of 17 to 20 digits. */
export const SNOWFLAKE = /^\d{17,20}$/;

/**
 * Whether the application's two public values are real. **A placeholder is anything else**,
 * which is what makes `<set when the Discord application exists>` safe to commit: it fails both
 * patterns, so a deploy made before the application exists answers 503 rather than verifying
 * Discord's signatures against nonsense or sending a reader to an authorize page that 404s.
 */
export function configured(env: Pick<Env, "DISCORD_APPLICATION_ID" | "DISCORD_PUBLIC_KEY">) {
  return (
    typeof env.DISCORD_APPLICATION_ID === "string" &&
    SNOWFLAKE.test(env.DISCORD_APPLICATION_ID) &&
    typeof env.DISCORD_PUBLIC_KEY === "string" &&
    /^[0-9a-f]{64}$/i.test(env.DISCORD_PUBLIC_KEY)
  );
}

/** `infrastructure/scan-worker/src/env.ts`'s five lines, copied for the reason that file gives. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * A refusal in the shape every Worker of this project answers: `{ error, code }`, matched by the
 * desktop on `code` and never on the sentence, which is written for a developer with a `curl`.
 */
export function refusal(
  status: number,
  code: string,
  error: string,
  headers: Record<string, string> = {},
): Response {
  return json({ error, code }, status, headers);
}

/** The 503 every route answers until {@link configured} is true. */
export function notConfigured(): Response {
  return refusal(503, "not_configured", "the Discord application is not set up on this server yet");
}

/** Ten minutes: how long a sign-in may take, from `POST /link/begin` to the claim. */
export const LINK_REQUEST_TTL_MS = 10 * 60 * 1000;

/** `bytes` as unpadded base64url — a code, a secret and a challenge are all spelled this way. */
export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** `length` random bytes, as {@link base64url}. */
export function randomToken(length: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(length)));
}

/** SHA-256 of `text`'s UTF-8. */
export async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/** SHA-256 of `text` as 64 lower-case hex characters — how a link secret is stored. */
export async function sha256Hex(text: string): Promise<string> {
  return [...(await sha256(text))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Whether two strings are equal, in time that does not depend on where they first differ.
 *
 * Used where one side is a secret's derivative a stranger is guessing at — a PKCE challenge — so
 * that the answer's timing cannot be walked a character at a time. A length that differs is
 * answered at once: both sides here are fixed-length encodings, so a length says nothing.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let at = 0; at < a.length; at += 1) difference |= a.charCodeAt(at) ^ b.charCodeAt(at);
  return difference === 0;
}

/**
 * A request body as bytes with a cap, or `null` when it is longer. Counted as it streams, so a
 * lying `content-length` changes nothing, and a stranger's body is never buffered whole before it
 * is refused.
 */
export async function boundedBytes(request: Request, cap: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) return null;
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || value === undefined) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/**
 * A JSON object body under `cap`, or `null` when it is too long, not JSON, or not an object. The
 * desktop's routes take a few hundred bytes — an invite is the longest thing any of them carries.
 */
export async function jsonBody(
  request: Request,
  cap: number,
): Promise<Record<string, unknown> | null> {
  const bytes = await boundedBytes(request, cap);
  if (bytes === null) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
