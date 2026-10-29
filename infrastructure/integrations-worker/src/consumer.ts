import { GROUP_PATTERN } from "./env";
import { isIntegration, RANDOM_ID, SCOPES, type Integration, type Scope } from "./intents";
import { fromBase64url, toBase64url } from "./seal";

/**
 * **A consumer token** (the PR 3 plan, §3.3): what an integration carries instead of a relay token
 * — `gct1.<base64url(claims JSON)>.<base64url(HMAC-SHA-256)>`, the MAC over the ASCII of
 * `gct1.<claims>` under the group's consumer key (`seal.ts`'s `consumerKey`, drawn from the
 * group's data key).
 *
 * ```json
 * { "grp": "<group>", "int": "discord" | "mcp", "scp": ["collection:read", …], "exp": <unix s>, "tid": "<22>" }
 * ```
 *
 * **Never a relay token, and never honoured where one is** (the spec's §6.3): the device routes
 * verify relay tokens under the relay's signing key, and this file has nothing to do with it. A
 * consumer that holds one of these can read the store's projection under its scopes and propose
 * intents; it cannot publish a share, post to the scan inbox or reach the relay — the Discord
 * branch's F8 cannot arise.
 *
 * **Two halves, in two places.** The router reads the claims *without* trusting them
 * ({@link decodeClaims}) for one thing: which group's object to ask. The object verifies the MAC
 * ({@link verifyToken}), `exp`, and that its `consumers` row for the integration still holds the
 * token's `tid` — a revoke deletes the row, a re-mint replaces the `tid`, and `deleteAll` takes
 * the key itself. A token whose claims will not even parse is a 401 that reaches no object.
 */

/** The version prefix: a token of another shape is no token of this Worker's. */
export const TOKEN_PREFIX = "gct1";

/**
 * A token's longest form. Five scopes, a 128-character group and the rest come to well under 600
 * characters; this bounds what the router decodes before any object is asked.
 */
const MAX_TOKEN_CHARS = 1024;

/** A token's claims, as signed. `exp` is Unix seconds, as the relay's tokens have it. */
export interface Claims {
  grp: string;
  int: Integration;
  scp: Scope[];
  exp: number;
  tid: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** `{ grp, int, scp, exp, tid }` exactly, each the type and shape it must be — or `null`. */
function claimsOf(value: unknown): Claims | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const claims = value as Record<string, unknown>;
  if (Object.keys(claims).sort().join() !== "exp,grp,int,scp,tid") return null;
  const { grp, int, scp, exp, tid } = claims;
  if (typeof grp !== "string" || !GROUP_PATTERN.test(grp)) return null;
  if (!isIntegration(int)) return null;
  if (!Array.isArray(scp) || !scp.every((s) => (SCOPES as readonly unknown[]).includes(s))) {
    return null;
  }
  if (typeof exp !== "number" || !Number.isSafeInteger(exp)) return null;
  if (typeof tid !== "string" || !RANDOM_ID.test(tid)) return null;
  return { grp, int, scp: scp as Scope[], exp, tid };
}

/** The two halves of a token, or `null` when it is not `gct1.<claims>.<mac>`. */
function split(token: string): { signed: string; claims: string; mac: string } | null {
  if (token.length > MAX_TOKEN_CHARS) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return null;
  return { signed: `${parts[0]}.${parts[1]}`, claims: parts[1], mac: parts[2] };
}

/**
 * **The claims as they read, unverified** — the router's question, which group to ask — or `null`
 * for anything that is not a token of this shape. Never a reason to admit: {@link verifyToken} is.
 */
export function decodeClaims(token: string): Claims | null {
  const parts = split(token);
  if (parts === null) return null;
  const bytes = fromBase64url(parts.claims);
  if (bytes === null) return null;
  try {
    return claimsOf(JSON.parse(decoder.decode(bytes)));
  } catch {
    return null;
  }
}

/** `claims`, signed under `key` — a token. */
export async function signToken(key: CryptoKey, claims: Claims): Promise<string> {
  const signed = `${TOKEN_PREFIX}.${toBase64url(encoder.encode(JSON.stringify(claims)))}`;
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(signed)));
  return `${signed}.${toBase64url(mac)}`;
}

/**
 * The claims of a token whose MAC holds under `key`, or `null`. **WebCrypto's `verify`**, so the
 * comparison is the platform's and not a loop of this file's. `exp` and the `tid` are the store's
 * to ask: they need the clock and the `consumers` row.
 */
export async function verifyToken(key: CryptoKey, token: string): Promise<Claims | null> {
  const parts = split(token);
  if (parts === null) return null;
  const mac = fromBase64url(parts.mac);
  if (mac?.length !== 32) return null;
  const holds = await crypto.subtle.verify("HMAC", key, mac, encoder.encode(parts.signed));
  return holds ? decodeClaims(token) : null;
}

/** A bearer header's token, or `null`. */
export function bearerOf(request: Request): string | null {
  const header = request.headers.get("authorization");
  return header?.startsWith("Bearer ") === true ? header.slice(7) : null;
}
