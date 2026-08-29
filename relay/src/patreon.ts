import { hex, hmacMd5, timingSafeEqualHex } from "./md5";
import type { Env } from "./index";

/**
 * The only Patreon-shaped code in the relay: the OAuth exchange, the identity read, and the
 * webhook signature. Everything downstream of this file speaks in a `patron_status` string and
 * a subject id, which is what lets a second source (Paddle, spec §5) arrive as a sibling of
 * this module rather than as a branch inside every handler.
 *
 * **Nothing here decides anything.** `entitlement.ts`'s `decide` turns a `patron_status` into a
 * `Status`; this module's job is to arrive at that string honestly and to refuse a body that
 * did not come from Patreon. The split matters because the two halves fail differently — a
 * wrong decision is a reader who should not be syncing, and a wrong signature check is a
 * stranger who can delete a reader's log.
 *
 * **Patreon API v2 only.** v1 retires 2026-10-07 and this design never touches it.
 */

/**
 * The OAuth token endpoint, used for both grant types. It is `www.patreon.com` and **not**
 * `api.patreon.com` — the v2 API lives under the `www` host, and the other one answers a
 * redirect that `fetch` follows into an HTML page rather than a token.
 */
const TOKEN_URL = "https://www.patreon.com/api/oauth2/token";

/**
 * The identity read, with the include path spelled `memberships.campaign` rather than the
 * `memberships` the design sketch carried.
 *
 * **The campaign is what makes the answer mean anything**, and asking for `memberships` alone
 * is not guaranteed to bring it. `fields[member]=patron_status` is a JSON:API *sparse
 * fieldset*, and a fieldset names the fields to return — relationships included — so a member
 * object returned under `include=memberships` may legitimately arrive with no `campaign`
 * linkage at all. Every reader would then match no campaign, read as no patron, and be told
 * they are not supporting. Naming the campaign in the include path closes it from the other
 * side: JSON:API's full-linkage rule requires an included resource to be reachable from the
 * document, so the member objects must carry the linkage that points at it.
 */
const IDENTITY_URL =
  "https://www.patreon.com/api/oauth2/v2/identity" +
  "?include=memberships.campaign&fields%5Bmember%5D=patron_status";

/**
 * Where Patreon sends the reader after they consent.
 *
 * **This must equal `entitlement::PATREON_REDIRECT_PATH` in the Rust byte for byte**, because
 * a redirect URI is matched exactly at two separate points: Patreon compares the authorize
 * request's against what was registered, and compares the token exchange's against the
 * authorize request's. A trailing slash on either side is a different URI and the exchange
 * fails with `invalid_grant`, which says nothing about a path.
 */
const REDIRECT_PATH = "/oauth/patreon/callback";

/** What the OAuth exchange and the daily refresh both answer. */
export interface PatreonTokens {
  accessToken: string;
  refreshToken: string;
}

/**
 * Who the reader is, and what they are to *this* campaign.
 *
 * `patronStatus` is Patreon's own string and is deliberately not narrowed — `entitlement.ts`
 * makes the same argument about the same value, and a union here would only mean tomorrow's
 * new value arrived as a lie. `null` is "no membership to this campaign", which `decide` reads
 * as `dead`, and that is the correct reading: a reader with memberships to five other creators
 * is not a supporter of this one.
 */
export interface Identity {
  userId: string;
  patronStatus: string | null;
}

/**
 * A binding, or a loud failure naming it.
 *
 * **An unset binding is `undefined` at runtime whatever `Env` says it is**, because `Env` is a
 * hand-written description of what a deploy is supposed to have set rather than anything the
 * type system can check against `wrangler.jsonc`. The failure that makes this worth a helper
 * is not the type: it is that most of these values end up inside a hash, where `undefined`
 * does not throw but silently becomes a *usable key*. `hmacMd5` accepts a zero-length key and
 * returns a perfectly valid digest, so an unset `PATREON_WEBHOOK_SECRET` would leave the
 * webhook verifying against HMAC-MD5-under-the-empty-key — a signature anybody can compute, on
 * the one route where failing open deletes a reader's log. Throwing is a 500 that names the
 * binding; the alternative is a relay that looks like it is working.
 *
 * It lives in this module because this is the one file in the entitlement layer that imports
 * nothing from its siblings, so `claim.ts` and `index.ts` can both reach it without a cycle.
 */
export function required(value: string | undefined, name: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`the relay is missing its ${name} binding`);
  }
  return value;
}

/** `{RELAY_BASE}/oauth/patreon/callback` — see `REDIRECT_PATH` for why it is exact. */
export function redirectUri(env: Env): string {
  return `${required(env.RELAY_BASE, "RELAY_BASE")}${REDIRECT_PATH}`;
}

/**
 * Trade the authorization code the reader's browser carried for a token pair.
 *
 * `redirect_uri` is sent again here even though the code already encodes which one was used —
 * that repetition is the OAuth spec's, and Patreon enforces it.
 */
export function exchangeCode(code: string, env: Env): Promise<PatreonTokens> {
  return postToken(env, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(env),
  });
}

/**
 * Trade a stored refresh token for a fresh access token, for the daily reconciliation.
 *
 * **Patreon rotates the refresh token on every use**, so the caller has to store the one that
 * comes back. Keeping the old one costs the next pass a `400` and the row silently stops being
 * reconciled — which is exactly the failure the reconciliation exists to catch, reproduced in
 * the reconciliation itself.
 */
export function refreshTokens(refreshToken: string, env: Env): Promise<PatreonTokens> {
  return postToken(env, { grant_type: "refresh_token", refresh_token: refreshToken });
}

/**
 * The form post both grants share.
 *
 * The client credentials go in the body rather than in a Basic header because that is the
 * shape Patreon documents. **No error raised here quotes the response body**: the token
 * endpoint echoes request parameters back in some failure shapes, and this request carries the
 * client secret.
 */
async function postToken(env: Env, fields: Record<string, string>): Promise<PatreonTokens> {
  const body = new URLSearchParams({
    ...fields,
    client_id: required(env.PATREON_CLIENT_ID, "PATREON_CLIENT_ID"),
    client_secret: required(env.PATREON_CLIENT_SECRET, "PATREON_CLIENT_SECRET"),
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!response.ok) {
    throw new Error(`the patreon token endpoint answered ${response.status}`);
  }

  const payload = (await response.json()) as { access_token?: unknown; refresh_token?: unknown };
  if (typeof payload.access_token !== "string" || typeof payload.refresh_token !== "string") {
    throw new Error("the patreon token endpoint answered no token pair");
  }
  return { accessToken: payload.access_token, refreshToken: payload.refresh_token };
}

/**
 * Who the access token belongs to, and their membership of this campaign.
 *
 * `null` means Patreon answered a document with no user id in it — **which is not the same
 * fact as "not a patron" and callers must not collapse the two.** A missing membership is an
 * answer ("they are not supporting"); an unreadable document is the absence of one, and
 * treating it as a cancellation is how a shape change on Patreon's side becomes a mass
 * revocation.
 */
export async function fetchIdentity(accessToken: string, env: Env): Promise<Identity | null> {
  const response = await fetch(IDENTITY_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`the patreon identity endpoint answered ${response.status}`);
  }
  return readIdentity(
    await response.json(),
    required(env.PATREON_CAMPAIGN_ID, "PATREON_CAMPAIGN_ID"),
  );
}

/**
 * The identity document, reduced to a user id and this campaign's `patron_status`.
 *
 * Pure, and separated from the `fetch` above for that reason: which membership counts is a
 * decision, and it is the decision that a reader supporting four other creators must not read
 * as supporting this one. Everything else in this module is I/O.
 *
 * A member object with no `patron_status` attribute answers `null` rather than throwing — the
 * field is a sparse-fieldset request and Patreon is entitled to omit it, and `decide` already
 * reads `null` as `dead`, which is the fail-closed direction.
 */
export function readIdentity(payload: unknown, campaignId: string): Identity | null {
  const root = payload as { data?: { id?: unknown }; included?: unknown } | null | undefined;
  const userId = root?.data?.id;
  if (typeof userId !== "string" || userId === "") return null;

  const listed = root?.included;
  const included: unknown[] = Array.isArray(listed) ? listed : [];
  for (const entry of included) {
    const member = entry as {
      type?: unknown;
      attributes?: { patron_status?: unknown };
      relationships?: { campaign?: { data?: { id?: unknown } } };
    } | null;
    if (member?.type !== "member") continue;
    if (member.relationships?.campaign?.data?.id !== campaignId) continue;

    const status = member.attributes?.patron_status;
    return { userId, patronStatus: typeof status === "string" ? status : null };
  }

  return { userId, patronStatus: null };
}

/**
 * The webhook body, reduced to the same pair `readIdentity` answers.
 *
 * A webhook's primary `data` **is** the member, so the Patreon user id is one relationship
 * hop away rather than at the root — the one structural difference from the identity document,
 * and the reason this is a second function rather than an argument to the first.
 *
 * `null` is "this body names no user", which the caller answers with a `204`: Patreon retries
 * a non-2xx, and retrying a body we will never understand is a loop.
 */
export function readMember(payload: unknown): Identity | null {
  const data = (
    payload as {
      data?: {
        attributes?: { patron_status?: unknown };
        relationships?: { user?: { data?: { id?: unknown } } };
      };
    } | null | undefined
  )?.data;

  const userId = data?.relationships?.user?.data?.id;
  if (typeof userId !== "string" || userId === "") return null;

  const status = data?.attributes?.patron_status;
  return { userId, patronStatus: typeof status === "string" ? status : null };
}

/**
 * Whether `X-Patreon-Signature` proves this body came from Patreon.
 *
 * **The body must be the raw text, read once.** Re-serialising the parsed JSON changes the
 * bytes — key order, whitespace, number formatting — and every signature then fails, which
 * reads as a broken secret rather than as a broken pipeline.
 *
 * **A missing header is refused before anything is compared, and that guard is not
 * decoration.** `timingSafeEqualHex("", "")` is `true` and is pinned as such by `md5.test.ts`,
 * so the tempting `timingSafeEqualHex(header ?? "", expected ?? "")` authenticates an
 * *unsigned* webhook the moment the expected digest is also empty. This is the one path in the
 * design where failing open destroys data: an unverified `members:pledge:delete` deletes a
 * reader's relay log.
 *
 * **The `secret` must already have been through `required`.** Unlike `crypto.subtle`, which
 * refuses a zero-length HMAC key outright, `hmacMd5` pads whatever it is given to a block and
 * returns a valid digest — so an unset webhook secret would not throw here, it would verify
 * against a key anybody can guess. The check is at the call site because that is where the
 * binding is, and the failure is a 500 naming it.
 *
 * MD5 is Patreon's choice and not a preference of this repository; see `md5.ts`. Do not
 * "fix" it to SHA-256 — that breaks every webhook and nothing in this tree would say why.
 */
export function verifyWebhook(body: string, signature: string | null, secret: string): boolean {
  if (signature === null || signature === "") return false;

  const encoder = new TextEncoder();
  const expected = hex(hmacMd5(encoder.encode(secret), encoder.encode(body)));
  return timingSafeEqualHex(signature, expected);
}
