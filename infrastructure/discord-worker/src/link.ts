import {
  LINK_REQUEST_TTL_MS,
  SNOWFLAKE,
  base64url,
  constantTimeEqual,
  json,
  jsonBody,
  randomToken,
  refusal,
  sha256,
  sha256Hex,
  type Env,
} from "./env";
import { page } from "./page";
import type { BotDeviceRpc, EnrollRefused } from "./rpc";

/**
 * Linking a Discord account to a desktop, and the routes the link opens (the design, §13.3).
 *
 * The sign-in is OAuth2's authorization-code flow, shaped like PKCE so that the desktop never
 * sees a Discord token and this Worker never keeps one:
 *
 * 1. `POST /link/begin { challenge }` — the desktop's `challenge = base64url(sha256(verifier))`
 *    is stored on a request keyed by a random `code`, ten minutes long, and the answer is the
 *    authorize URL with `state=<code>`.
 * 2. `GET /oauth/discord/callback` — Discord's redirect. The code is exchanged with the client
 *    secret, `/users/@me` names who signed in, the request is stamped with them, and the access
 *    token is dropped there and then.
 * 3. `POST /link/claim { code, verifier }` — polled by the desktop. Once the request names a
 *    user, a **link secret** is minted, its SHA-256 alone is stored, the request is deleted, and
 *    the secret is answered — once. **The verifier is what stops whoever saw `state` in a
 *    browser's address bar from claiming the link first.**
 *
 * **A link is one Discord account and one Durable Object.** The object's id is minted with
 * `BOT.newUniqueId()` the first time the account's link is claimed and kept on its row:
 *
 * - **Linking again while linked** replaces the secret — the old one stops working at once — and
 *   **keeps the Durable Object**, so a bot already enrolled in the reader's group stays the same
 *   device and keeps its place among their five. A desktop that re-links and then asks to enroll
 *   a bot that is already enrolled is answered `409 already_enrolled`; to put the bot in another
 *   group it unlinks first (`DELETE /link`), which ends the old identity.
 * - **Linking after an unlink** finds no row, so it mints a fresh Durable Object: `unlink()`
 *   deleted the old one's storage for good, and nothing could make it a device again.
 */

/** Discord's own endpoints, all at API version 10. */
export const DISCORD_API = "https://discord.com/api/v10";
export const AUTHORIZE = "https://discord.com/oauth2/authorize";
/**
 * Discord asks every client of its HTTP API for a `User-Agent` of this shape, and Cloudflare in
 * front of it refuses some requests without one.
 */
export const DISCORD_USER_AGENT = "DiscordBot (https://github.com/Msgaihede/mtg-grimoire, 1.0)";

/** `identify` names who signed in; `applications.commands` installs the commands to them. */
export const SCOPES = "identify applications.commands";

/** A request's code: 24 random bytes, base64url. */
const CODE = /^[A-Za-z0-9_-]{32}$/;
/** A challenge: a SHA-256, base64url — always 43 characters. */
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
/** A verifier, as RFC 7636 spells one: 43 to 128 unreserved characters. */
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
/** A link secret: 32 random bytes, base64url. */
const SECRET = /^[A-Za-z0-9_-]{43}$/;

/**
 * The longest invite the enroll route takes. An invite is `pairing::Offer.code` — a few hundred
 * characters of base64url at most — and the cap is room for that and nothing like a payload.
 */
export const MAX_INVITE_CHARS = 2048;

export const redirectUri = (env: Env) => `${env.DISCORD_BASE}/oauth/discord/callback`;

interface RequestRow {
  code: string;
  challenge: string;
  state: "pending" | "authorized" | "denied";
  discord_user_id: string | null;
  username: string | null;
  expires_at: number;
}

export interface LinkRow {
  discord_user_id: string;
  username: string;
  do_id: string;
}

/**
 * The link requests past their ten minutes, deleted. **Lazily, on every begin** — one indexed
 * statement, so the table holds what is in flight and little else — and by the daily cron
 * (`sweep.ts`) for the day nobody begins. An expired row is also deleted the moment a claim or a
 * callback reads it.
 */
export async function sweepRequests(env: Env, now: number): Promise<void> {
  await env.DB.prepare(`DELETE FROM discord_link_requests WHERE expires_at <= ?`).bind(now).run();
}

async function requestRow(env: Env, code: string): Promise<RequestRow | null> {
  return env.DB.prepare(
    `SELECT code, challenge, state, discord_user_id, username, expires_at FROM discord_link_requests WHERE code = ?`,
  )
    .bind(code)
    .first<RequestRow>();
}

async function forgetRequest(env: Env, code: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM discord_link_requests WHERE code = ?`).bind(code).run();
}

const notSetUp = () =>
  refusal(503, "not_configured", "the Discord sign-in is not set up on this server yet");

// ---------------------------------------------------------------------------------------
// POST /link/begin
// ---------------------------------------------------------------------------------------

export async function handleBegin(request: Request, env: Env, now: number): Promise<Response> {
  if (!env.DISCORD_CLIENT_SECRET) return notSetUp();
  const body = await jsonBody(request, 4096);
  const challenge = body?.challenge;
  if (typeof challenge !== "string" || !CHALLENGE.test(challenge)) {
    return refusal(400, "bad_request", "send { challenge }: base64url of a verifier's SHA-256");
  }
  await sweepRequests(env, now);
  const code = randomToken(24);
  const expiresAt = now + LINK_REQUEST_TTL_MS;
  await env.DB.prepare(
    `INSERT INTO discord_link_requests (code, challenge, state, discord_user_id, username, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(code, challenge, "pending", null, null, now, expiresAt)
    .run();

  // Written out rather than through `URLSearchParams`, which spells the scopes' space `+`.
  const query = [
    ["client_id", env.DISCORD_APPLICATION_ID],
    ["response_type", "code"],
    ["redirect_uri", redirectUri(env)],
    ["scope", SCOPES],
    ["state", code],
    // A user install: the commands go to the reader's account, not to a server.
    ["integration_type", "1"],
    ["prompt", "consent"],
  ]
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
  return json({ code, authorizeUrl: `${AUTHORIZE}?${query}`, expiresAt });
}

// ---------------------------------------------------------------------------------------
// GET /oauth/discord/callback
// ---------------------------------------------------------------------------------------

const RETURN = "Return to MTG Grimoire";

/** Who signed in, from Discord: the code exchanged, then `/users/@me`. `null` on any failure. */
async function whoSignedIn(
  env: Env,
  secret: string,
  code: string,
): Promise<{ id: string; username: string } | null> {
  try {
    const exchanged = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${btoa(`${env.DISCORD_APPLICATION_ID}:${secret}`)}`,
        "user-agent": DISCORD_USER_AGENT,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri(env),
      }).toString(),
      signal: AbortSignal.timeout(5000),
    });
    if (!exchanged.ok) return null;
    const token = ((await exchanged.json()) as { access_token?: unknown }).access_token;
    if (typeof token !== "string" || token === "") return null;

    const me = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { authorization: `Bearer ${token}`, "user-agent": DISCORD_USER_AGENT },
      signal: AbortSignal.timeout(5000),
    });
    // **The token goes out of scope here, unrevoked and unstored**: nothing keeps it, and
    // revoking it would also withdraw the installation it just granted.
    if (!me.ok) return null;
    const user = (await me.json()) as { id?: unknown; username?: unknown };
    if (typeof user.id !== "string" || !SNOWFLAKE.test(user.id)) return null;
    if (typeof user.username !== "string" || user.username === "") return null;
    return { id: user.id, username: user.username.slice(0, 100) };
  } catch {
    return null;
  }
}

export async function handleCallback(request: Request, env: Env, now: number): Promise<Response> {
  const secret = env.DISCORD_CLIENT_SECRET;
  if (!secret) {
    return page(
      "Discord isn't set up yet",
      "This server cannot finish a Discord sign-in yet.",
      503,
    );
  }
  const params = new URL(request.url).searchParams;
  const state = params.get("state");
  if (state === null || !CODE.test(state)) {
    return page("Nothing to finish here", "This page is reached from Discord's sign-in.", 400);
  }
  const row = await requestRow(env, state);
  if (row === null || row.expires_at <= now) {
    if (row !== null) await forgetRequest(env, state);
    return page(
      "This sign-in has expired",
      `${RETURN} and switch the Discord integration on again.`,
      410,
    );
  }
  if (row.state !== "pending") {
    return page("This sign-in is already finished", `${RETURN}.`, 409);
  }

  // `error=access_denied` is a press on Cancel on Discord's page; any other error ends the
  // request the same way, so the desktop's poll stops on 409 rather than waiting it out.
  if (params.get("error") !== null) {
    await env.DB.prepare(
      `UPDATE discord_link_requests SET state = 'denied' WHERE code = ? AND state = 'pending'`,
    )
      .bind(state)
      .run();
    return page("Discord was not linked", `You declined on Discord's page. ${RETURN}.`);
  }
  const code = params.get("code");
  if (code === null || code === "" || code.length > 512) {
    return page("Nothing to finish here", "Discord sent no sign-in code.", 400);
  }

  const user = await whoSignedIn(env, secret, code);
  if (user === null) {
    return page("Discord did not finish the sign-in", `${RETURN} and try again in a moment.`, 502);
  }
  await env.DB.prepare(
    `UPDATE discord_link_requests SET state = 'authorized', discord_user_id = ?, username = ? WHERE code = ? AND state = 'pending'`,
  )
    .bind(user.id, user.username, state)
    .run();
  return page(`Linked as ${user.username}`, `${RETURN} — it finishes linking by itself.`);
}

// ---------------------------------------------------------------------------------------
// POST /link/claim
// ---------------------------------------------------------------------------------------

export async function handleClaim(request: Request, env: Env, now: number): Promise<Response> {
  const body = await jsonBody(request, 4096);
  const code = body?.code;
  const verifier = body?.verifier;
  if (
    typeof code !== "string" ||
    !CODE.test(code) ||
    typeof verifier !== "string" ||
    !VERIFIER.test(verifier)
  ) {
    return refusal(400, "bad_request", "send { code, verifier }");
  }
  const expired = () =>
    refusal(410, "link_expired", "this sign-in has expired; switch the integration on again");

  const row = await requestRow(env, code);
  if (row === null) return expired();
  if (row.expires_at <= now) {
    await forgetRequest(env, code);
    return expired();
  }
  // **Ahead of every answer about the request's state**, so a caller without the verifier
  // learns nothing — not even whether the reader has signed in yet.
  if (!constantTimeEqual(base64url(await sha256(verifier)), row.challenge)) {
    return refusal(403, "link_mismatch", "this verifier is not the one this sign-in began with");
  }
  if (row.state === "denied") {
    await forgetRequest(env, code);
    return refusal(409, "link_denied", "the reader declined on Discord's page");
  }
  if (row.state === "pending") return json({ status: "pending" }, 202);

  // **Single use under two racing claims**: the request is deleted in the statement that reads
  // who it names, so only one of them gets a row back.
  const { results } = await env.DB.prepare(
    `DELETE FROM discord_link_requests WHERE code = ? AND state = 'authorized' RETURNING discord_user_id, username`,
  )
    .bind(code)
    .all<{ discord_user_id: string; username: string }>();
  const taken = results[0];
  if (taken === undefined) return expired();

  const secret = randomToken(32);
  const hash = await sha256Hex(secret);
  // The class docblock has the rule: a link that exists keeps its Durable Object and gets a new
  // secret; a first link mints the object. One statement either way, so two claims for one
  // account cannot both insert — the primary key is the account.
  const doId = env.BOT.newUniqueId().toString();
  await env.DB.prepare(
    `INSERT INTO discord_links (discord_user_id, username, secret_hash, do_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (discord_user_id) DO UPDATE SET secret_hash = excluded.secret_hash, username = excluded.username`,
  )
    .bind(taken.discord_user_id, taken.username, hash, doId, now)
    .run();
  return json({
    status: "linked",
    secret,
    discordUserId: taken.discord_user_id,
    username: taken.username,
  });
}

// ---------------------------------------------------------------------------------------
// The bearer, and the routes behind it
// ---------------------------------------------------------------------------------------

/** The 401 every bearer route answers to a missing, malformed or unknown secret. */
export const notLinked = () =>
  refusal(401, "not_linked", "this desktop is not linked to a Discord account");

/** The link the request's bearer names, or `null`. Looked up by the secret's SHA-256. */
export async function linkedBy(request: Request, env: Env): Promise<LinkRow | null> {
  const header = request.headers.get("authorization");
  const secret = header?.startsWith("Bearer ") === true ? header.slice(7) : null;
  if (secret === null || !SECRET.test(secret)) return null;
  return env.DB.prepare(
    `SELECT discord_user_id, username, do_id FROM discord_links WHERE secret_hash = ?`,
  )
    .bind(await sha256Hex(secret))
    .first<LinkRow>();
}

/** The link a Discord user has, for an interaction they sent. */
export async function linkOf(env: Env, discordUserId: string): Promise<LinkRow | null> {
  return env.DB.prepare(
    `SELECT discord_user_id, username, do_id FROM discord_links WHERE discord_user_id = ?`,
  )
    .bind(discordUserId)
    .first<LinkRow>();
}

/** The link's Durable Object. */
export function botOf(env: Env, link: LinkRow): BotDeviceRpc {
  return env.BOT.get(env.BOT.idFromString(link.do_id));
}

/** A Durable Object call that threw — the bot device not deployed, or failing. */
const unavailable = () =>
  refusal(502, "bot_unavailable", "the bot device could not be reached; try again in a moment");

/** §13.3's statuses for the Durable Object's three refusals. */
export const ENROLL_STATUS: Record<EnrollRefused["code"], number> = {
  already_enrolled: 409,
  bad_invite: 422,
  pairing_failed: 502,
};

/** `POST /link/enroll { invite, capability: "add" }` — `add` and nothing else (§14.1). */
export async function handleEnroll(request: Request, env: Env, link: LinkRow): Promise<Response> {
  const body = await jsonBody(request, MAX_INVITE_CHARS + 256);
  const invite = body?.invite;
  if (
    typeof invite !== "string" ||
    invite.trim() === "" ||
    invite.length > MAX_INVITE_CHARS ||
    body?.capability !== "add"
  ) {
    return refusal(400, "bad_request", 'send { invite, capability: "add" }');
  }
  let answer: Awaited<ReturnType<BotDeviceRpc["enroll"]>>;
  try {
    answer = await botOf(env, link).enroll({ invite, capability: "add" });
  } catch {
    // The desktop has an invite waiting and nobody answered it: as far as it can tell the
    // pairing failed, and §13.3 has one answer for that.
    return refusal(502, "pairing_failed", "the bot device could not be reached");
  }
  if (answer.ok) {
    return json({ deviceId: answer.deviceId, x25519: answer.x25519, ed25519: answer.ed25519 });
  }
  const status = ENROLL_STATUS[answer.code] ?? 502;
  return refusal(
    status,
    answer.code in ENROLL_STATUS ? answer.code : "pairing_failed",
    answer.error,
  );
}

/** `GET /link`: the link row, and what its Durable Object says of itself. */
export async function handleStatus(env: Env, link: LinkRow): Promise<Response> {
  let status: Awaited<ReturnType<BotDeviceRpc["status"]>>;
  try {
    status = await botOf(env, link).status();
  } catch {
    return unavailable();
  }
  return json({
    discordUserId: link.discord_user_id,
    username: link.username,
    enrolled: status.enrolled,
    deviceId: status.deviceId,
    paired: status.paired,
    lastPullAt: status.lastPullAt,
  });
}

/**
 * `DELETE /link`: the Durable Object's storage, then the row. **In that order**, so a failure
 * part-way leaves a link the desktop can delete again rather than a bot identity nothing points
 * at — the desktop retries on the 502 and the row is still there to find the object by.
 */
export async function handleUnlink(env: Env, link: LinkRow): Promise<Response> {
  try {
    await botOf(env, link).unlink();
  } catch {
    return unavailable();
  }
  await env.DB.prepare(`DELETE FROM discord_links WHERE discord_user_id = ?`)
    .bind(link.discord_user_id)
    .run();
  return new Response(null, { status: 204 });
}
