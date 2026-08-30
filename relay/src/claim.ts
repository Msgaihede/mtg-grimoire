import { decide, type Status } from "./entitlement";
import {
  admitDevice,
  authIsCurrent,
  forgetGroup,
  MAX_GROUP_DEVICES,
  seedGroup,
} from "./groupauth";
import { hex } from "./md5";
import {
  exchangeCode,
  fetchIdentity,
  type Identity,
  readMember,
  refreshTokens,
  required,
  verifyWebhook,
} from "./patreon";
import { mint, TOKEN_TTL_MS } from "./token";
// **`import type` and never a value import**, because `index.ts` imports this file: a value
// import would close a runtime cycle, and a cycle in which one side builds a route table out of
// the other side's functions at module-evaluation time is exactly the shape that resolves to
// `undefined` under one bundler and throws under another. `import type` is erased outright, so
// there is no edge at all.
import type { Env } from "./index";

/**
 * The entitlement layer's four routes and the daily reconciliation: the OAuth landing page,
 * `/claim`, `/token` and the Patreon webhook.
 *
 * **Everything in this file counts in milliseconds, and the wire counts in seconds.** `decide`
 * takes a `nowMs`, `TOKEN_TTL_MS` is milliseconds, `grace_until` is compared against `nowMs`,
 * and so every timestamp this module stores in D1 is milliseconds too — one unit inside, so
 * there is no column whose reading depends on which handler wrote it. The single conversion is
 * `unixSeconds`, at the two places a grant is built, **because the app counts in seconds**:
 * `sync_engine::entitlement` compares `expires` against `unixepoch()` exactly as `last_sync_at`
 * already does. Milliseconds crossing that boundary do not fail loudly — they make
 * `expires - now` about 1.8e12, forever larger than the six-hour refresh margin, so the app
 * never refreshes, and twenty-four hours later the relay 401s every *sync* request, on a route
 * that cannot re-mint. Sync dies silently and permanently. The app holds a magnitude guard for
 * the same reason; this is the half that has to be right.
 *
 * **`/claim` carries the group id in its body and there is no second channel.** The access
 * token's payload is `{sub, grp, exp}` and the gate compares `grp` against the `/g/{group}/…`
 * path segment before the Durable Object hop — so the relay must be told which group to bind
 * and to stamp. `/claim` carries no `Authorization` header (the whole point of the call is that
 * the device has no token yet) and `claim_codes` has no group column. A claim without it mints
 * a token matching no group: Patreon connects, and every later push, pull and ack 401s for
 * ever.
 *
 * **`/token` has two doors and they are looked up by different columns.** The refresh door finds
 * a row by `refresh_secret` and serves the one device that pressed Connect; the group door finds
 * a row by `group_id` and serves any device that can derive the group's `relay_auth` — which is
 * every device holding the group key, and is the whole of spec §2.2. The two must never be
 * collapsed into one `SELECT … WHERE refresh_secret = ? OR group_id = ?`: a row is findable by
 * either column, so an `OR` would open a row to a caller presenting the *group id* — a value
 * that travels in the clear in every `/g/…` path — in the field that is supposed to hold a
 * secret.
 *
 * **Every one of the three bodies carries a `device`, and it is required rather than optional
 * (spec §4.2).** A cap a caller can step round by leaving a field out is not a cap, and this
 * repository is public — the point of a device limit is precisely the case where somebody has a
 * reason to exceed it. `/token`'s *refresh* door carries one for a second reason: the connecting
 * device reaches the relay through that door and never the group one, so a count that skipped it
 * would never count the one device that is certainly signed in.
 *
 * ⚠️ **A full group is a 403 and never a 401.** `sync_engine::entitlement`'s 401 path clears the
 * grant, so refusing the sixth device with one would tell a reader their membership had ended at
 * the moment they added a laptop. The two statuses mean different things on this route and the
 * app acts on the difference.
 */

/**
 * Crockford base32, in encode order. No `I`, `L`, `O` or `U`.
 *
 * The same alphabet `sync_pair::invite` uses, and for the same reason: it folds the confusions
 * a person makes copying characters between two screens, which is the entire job of a code the
 * reader reads off a browser page and types into an app.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * The characters a minted group uid can contain, as one source for two patterns.
 *
 * `index.ts` builds its `ROUTE` from this string and this file anchors it for the group id that
 * arrives in a `/claim` body. **It lives here rather than with the router because the binding is
 * the write that cannot be taken back**: a path segment the router refuses is a 404, while a
 * group id bound to an entitlement mints tokens whose `grp` names a segment `ROUTE` rejects —
 * a claim that succeeds and a sync that can never work, with nothing to say why. Two patterns
 * that must agree eventually will not, and this is the direction the disagreement is expensive
 * in.
 */
export const GROUP_SEGMENT = "[A-Za-z0-9_-]{1,128}";

/** The same rule, anchored, for a group id that arrives in a body rather than in a path. */
export const GROUP_ID = new RegExp(`^${GROUP_SEGMENT}$`);

/**
 * A group's `relay_auth` on the wire: HKDF-SHA256's thirty-two bytes as lowercase hex, and
 * nothing else (spec §2.1).
 *
 * **It is checked at the route rather than in `groupauth.ts`, and the split is deliberate.** That
 * module compares and stores; this one decides what is allowed to reach it. An `auth` that has
 * not been through here reaches `equalsConstantTime` — whose own doc leans on both sides being
 * 64 hex characters for its length check not to be a near miss — and, on `/claim`, reaches a D1
 * write that fixes the group's credential for as long as nobody rotates it.
 *
 * Lowercase only, because `hex` in `md5.ts` and `hex::encode` in the Rust both emit lowercase and
 * neither side ever normalises: accepting upper case here would store a value that no device
 * derives, and the group would be locked out of its own auth at the next `/token`.
 */
export const RELAY_AUTH = /^[0-9a-f]{64}$/;

/**
 * A device id arriving in a body, anchored, from the character class `GROUP_SEGMENT` gives a
 * group id. `sync_pair::identity::ensure` mints one as sixteen random bytes in lowercase hex.
 *
 * **It is checked with the care `group` is checked with, because it reaches the same kind of
 * write.** An unchecked value lands in `group_devices.device_id` and is then compared against a
 * manifest's key set by `keepOnly` and against `/keys`'s `?device=` by `rotate.ts` — so `%41` and
 * `A` would be one device in the reader's head, two rows against the cap, and no later point at
 * which the disagreement becomes visible.
 *
 * `rotate.ts` spells this same pattern from the same `GROUP_SEGMENT` rather than importing it,
 * and that file's doc gives the reason: the shared thing worth sharing is the character class,
 * and a constant named for one kind of id is a constant a later reader assumes is checking that
 * kind. The duplication is two tokens wide and the class it is built from is single-sourced.
 */
export const DEVICE_ID = new RegExp(`^${GROUP_SEGMENT}$`);

/**
 * What a reader is told when their sixth device asks for a token.
 *
 * **It names the number rather than saying "too many devices"**, because the sentence has to be
 * actionable from a panel that shows a roster: a reader who knows the limit is five can look at
 * five rows and pick one to remove. `MAX_GROUP_DEVICES` is interpolated rather than typed out —
 * a limit spelled twice is a limit that eventually disagrees with itself.
 */
const GROUP_FULL =
  `this membership already has ${MAX_GROUP_DEVICES} devices signed in — ` +
  `remove one from a device that is still in the group to make room`;

/**
 * The machine-readable half of the cap refusal, and the reason it exists is a near-miss.
 *
 * **A 403 already meant two other things on `/claim`** — *that membership no longer exists* and
 * *that membership is not active*, both older than the cap — so an app branching on the status
 * alone tells a reader whose pledge has lapsed that they have five devices. That is the wrong
 * sentence about the wrong problem, and it was caught by reading the other side's file rather
 * than by any test, because each suite asserts its own half and both were green.
 *
 * **A code rather than the sentence, because the sentence is copy.** `sync_engine::entitlement`
 * matching on this string would break the app the day somebody improved the wording — which is
 * exactly the kind of edit prose invites. The code is the contract; `error` stays free to change.
 */
const DEVICE_LIMIT = "device_limit";

/** Characters in a claim code, before the separators. Twelve, as three groups of four. */
const CODE_CHARS = 12;

/** Characters per hyphen-separated group. Cosmetic — `normaliseCode` strips every separator. */
const CODE_GROUP = 4;

/**
 * Ten minutes (spec §6.1). The window is short because the code is carried by hand between a
 * browser and an app that are both already open; anything longer is a code sitting in a
 * screenshot.
 */
const CODE_TTL_MS = 10 * 60 * 1000;

/** Bytes in a refresh secret. 32, so it is a key rather than a password. */
const SECRET_BYTES = 32;

/**
 * How many entitlement rows the daily reconciliation reads at once, and how many pages it will
 * walk before it stops. The product is the ceiling on one pass, and it is deliberate: a cron
 * invocation has a wall-clock budget and each row costs two Patreon round trips, so a pass that
 * tried to walk an unbounded table would be killed part-way with no record of where it stopped.
 * A relay with more rows than this reconciles the rest tomorrow, which is what a backstop is
 * allowed to do — the webhook is the primary (spec §7.3).
 */
const RECONCILE_PAGE = 50;
const RECONCILE_PAGES = 20;

/** The entitlement row, in SQLite's snake_case. Every timestamp is milliseconds. */
type EntitlementRow = {
  subject: string;
  status: string;
  grace_until: number | null;
  group_id: string | null;
  refresh_secret: string | null;
  patreon_refresh: string | null;
  created_at: number;
};

/**
 * What `/claim` and `/token`'s **refresh** door answer, and it is five fields rather than the two
 * the design sketch carried. `sync_engine::entitlement::Grant` deserialises exactly this shape: a
 * name that disagrees, or a sixth field where `since` should be, is a body serde refuses at
 * runtime while every test on both sides stays green.
 */
interface Grant extends GroupGrant {
  refresh: string;
}

/**
 * What `/token`'s **group** door answers — the same thing minus the refresh secret, and the
 * omission is the point rather than an economy.
 *
 * A device that reached `/token` by proving it is in the group has proved nothing about the
 * Patreon account behind it. Handing that device the credential which can revoke, rebind and
 * re-register the group would make every paired device able to evict every other one, which is
 * precisely the failure `pairing.rs` dropping the secret from its blob exists to prevent
 * (spec §2.2). `sync_engine::entitlement::GroupGrant` deserialises this four-field shape.
 *
 * It is the *base* of `Grant` rather than an `Omit<Grant, "refresh">` so that `grantFor` can
 * build it without ever being handed a secret: the one door that holds one adds it afterwards.
 * A structural subtraction would leave the secret in the minting function's arguments, one
 * careless spread away from the wire.
 */
interface GroupGrant {
  access: string;
  expires: number;
  status: Status;
  since: number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ---------------------------------------------------------------------------------------
// The decisions, kept out of the handlers so they can be read and tested on their own
// ---------------------------------------------------------------------------------------

/**
 * A millisecond instant as the unix **second** the wire carries. See this module's doc for
 * what a millisecond reaching the app costs.
 */
export function unixSeconds(ms: number): number {
  return Math.floor(ms / 1000);
}

/**
 * What a **stored** row means *now*, as against what it meant when it was written.
 *
 * This is not `decide` and cannot be: `decide` maps a fresh `patron_status` from Patreon, and
 * this maps a status this relay already wrote plus the clock. The one thing it adds is the
 * question no webhook ever asks — **has a grace window closed?** A window opens on a decline
 * and closes seven days later with nothing to announce it, so every path that serves off a
 * stored row has to ask, or a declined reader syncs for ever.
 *
 * **`nowMs > graceUntil` mirrors `decide`'s comparison deliberately**: the deadline instant is
 * the last one *inside* the window, and the two functions must agree at it or a reader's status
 * would depend on which of them the request happened to go through.
 *
 * A `grace` row with no deadline is `dead`. `decide` never writes that pair, but a window with
 * no closing time is worse than a closed one, and this is the fail-closed direction.
 */
export function settle(status: string, graceUntil: number | null, nowMs: number): Status {
  if (status === "active") return "active";
  if (status !== "grace") return "dead";
  if (graceUntil === null || graceUntil <= 0) return "dead";
  return nowMs > graceUntil ? "dead" : "grace";
}

/**
 * Twelve random bytes as a displayed claim code, `XXXX-XXXX-XXXX`.
 *
 * **`byte & 31` is uniform and a modulo would not be.** A byte is 0–255 and 256 is exactly
 * eight times 32, so masking the low five bits leaves every character equally likely; `% 32`
 * happens to be the same arithmetic here, but the mask says why it is safe and survives
 * somebody changing the alphabet's size.
 *
 * Sixty bits of entropy over a ten-minute window, against codes that are single-use and only
 * ever redeemed by a reader who already holds one.
 */
export function codeFrom(bytes: Uint8Array): string {
  if (bytes.length < CODE_CHARS) {
    throw new Error(`a claim code needs ${CODE_CHARS} random bytes`);
  }

  let out = "";
  for (let i = 0; i < CODE_CHARS; i += 1) {
    if (i > 0 && i % CODE_GROUP === 0) out += "-";
    out += ALPHABET[bytes[i] & 31];
  }
  return out;
}

/**
 * The stored form of a claim code: separators gone, upper case, and Crockford's three
 * substitutions folded.
 *
 * **`codeFrom`'s output normalises to itself minus the hyphens**, because the alphabet contains
 * none of `I`, `L`, `O` or `U` — so what is stored at mint time and what is looked up at claim
 * time are the same function of the same string, and the mint side needs no second spelling.
 *
 * `I` and `L` fold to `1` and `O` to `0`, which is Crockford's own rule and `invite.rs`'s. `U`
 * is *dropped* rather than folded, because it stands for nothing: a code containing one is a
 * code that was mistyped into a different length, and a length that does not match is a lookup
 * that finds nothing — which is the right answer, arrived at without inventing a substitution
 * Crockford does not define.
 */
export function normaliseCode(input: string): string {
  const cleaned = input.replace(/[^0-9A-Za-z]/g, "").toUpperCase();

  let out = "";
  for (const character of cleaned) {
    if (character === "I" || character === "L") out += "1";
    else if (character === "O") out += "0";
    else if (ALPHABET.includes(character)) out += character;
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// The grant
// ---------------------------------------------------------------------------------------

/** A fresh refresh secret. `hex` is `md5.ts`'s, so the relay has one hex writer rather than two. */
function randomSecret(): string {
  return hex(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)));
}

/**
 * Mint an access token and dress it as the four fields **every** answer this file gives carries.
 *
 * **The refresh secret is not a parameter, and that is the fence.** Two of the three callers hold
 * one and the third must never send one; a function that took it would put the group door one
 * careless argument away from leaking the credential that can evict every device in the group.
 * The two doors that answer a `Grant` spread this result and add `refresh` themselves.
 *
 * The signing key is fetched through `required` rather than passed as `env.RELAY_HMAC_KEY` or,
 * worse, `String(env.RELAY_HMAC_KEY)`: an unset binding spelled that way signs every token with
 * the literal text `"undefined"`, and every token then verifies — for anyone who guesses that
 * the binding is unset. Unset has to be a loud 500.
 */
async function grantFor(
  env: Env,
  subject: string,
  group: string,
  status: Status,
  createdAtMs: number,
): Promise<GroupGrant> {
  const exp = Date.now() + TOKEN_TTL_MS;
  const access = await mint(
    { sub: subject, grp: group, exp },
    required(env.RELAY_HMAC_KEY, "RELAY_HMAC_KEY"),
  );
  return {
    access,
    expires: unixSeconds(exp),
    status,
    since: unixSeconds(createdAtMs),
  };
}

/**
 * Spec §7.1, in one place because it is reached from four: the webhook, the daily
 * reconciliation, `/token` when a grace window has closed, and the OAuth callback when a reader
 * who has already lapsed connects again.
 *
 * The refresh secret goes first and it is what actually revokes: deleting it is instantaneous,
 * while an `access` already issued dies of old age within the day. Then the group's log is
 * dropped — **the reader loses no data by it**, because every device holds the whole collection
 * in its own SQLite and the log is a transport buffer with a thirty-day tail.
 *
 * **It is allowed to throw, and each caller decides what that costs.** A failed drop must not
 * turn `/token`'s 401 into a 500, and must not stop the callback rendering its page; but it
 * *should* fail the webhook, because Patreon retries a non-2xx and the whole operation is
 * idempotent — which is a free second attempt at the one thing in this design that leaves a
 * reader's ciphertext sitting on the relay.
 */
async function revoke(env: Env, subject: string, groupId: string | null): Promise<void> {
  await env.DB.prepare(
    `UPDATE entitlements
        SET status = 'dead', grace_until = NULL, refresh_secret = NULL, checked_at = ?
      WHERE subject = ?`,
  )
    .bind(Date.now(), subject)
    .run();

  if (groupId !== null) await dropGroup(env, groupId);
}

/**
 * Empty a group's relay log.
 *
 * **The path is one the Worker builds and no device can reach.** `index.ts`'s `ROUTE` matches
 * `push|pull|ack|ws` and nothing else, so `/g/{group}/drop` is a 404 from the outside; the only
 * way to it is this function, which is called by the entitlement layer alone. That is the whole
 * of the authorisation — a `drop` behind the auth gate would still be a route a device holding
 * a valid token could aim at its own group.
 */
/**
 * The `device` field of a body, or `null` for "not a device id" — one reader for all three
 * bodies, so the three cannot drift into three different ideas of what a device id is.
 *
 * Returning the *narrowed string* rather than a boolean is what stops a caller re-reading
 * `body.device` afterwards as `unknown` and passing it on with a cast.
 */
function deviceIn(body: { device?: unknown }): string | null {
  const device = body.device;
  return typeof device === "string" && DEVICE_ID.test(device) ? device : null;
}

/**
 * Everything the relay holds for a group a subject has just stopped being bound to: the key
 * history, the device roll, and the log itself (spec §3).
 *
 * **Called after the new binding has been written and never before it**, which is the ordering
 * the whole reversal turns on. A teardown that ran first would destroy the reader's working group
 * on its way to a 409 — and the 409 that survives is *another subject holding this group id*,
 * which is exactly the mistake a reader makes by pairing into somebody else's group and then
 * pressing Connect. Refusals must destroy nothing; that is what
 * "registers nothing when the binding is refused" already says about `group_keys`.
 *
 * **Every failure here is logged and swallowed, and the residue is harmless by construction.**
 * The reader is standing in front of a Connect press whose binding has already moved, so a 500
 * would report failure for an operation that succeeded. What can be left behind is rows in a
 * group no subject is bound to: `group_devices` rows counted only by a per-group count nobody
 * will take again, `group_keys` rows for a group whose entitlement is gone — and a log with a
 * thirty-day tail, which is the only one holding bytes and is the one that expires on its own.
 */
async function releaseGroup(env: Env, group: string): Promise<void> {
  try {
    await env.DB.prepare(`DELETE FROM group_keys WHERE group_id = ?`).bind(group).run();
    await forgetGroup(env, group);
    // Last, because it is the only step that leaves D1 — a Durable Object that cannot be reached
    // must not cost the two deletes above, which are what free the slots and retire the key.
    await dropGroup(env, group);
  } catch (error) {
    console.error("claim release", error);
  }
}

async function dropGroup(env: Env, group: string): Promise<void> {
  // A group id that could not have come from `ROUTE` names an object no device ever wrote to,
  // and interpolating it into a URL is the one place a stray character could address something
  // else. `/claim` refuses such an id before binding it, so this is a second fence on a value
  // that is already stored.
  if (!GROUP_ID.test(group)) return;

  const stub = env.GROUP.get(env.GROUP.idFromName(group));
  const response = await stub.fetch(`https://relay.internal/g/${group}/drop`, { method: "POST" });
  if (!response.ok) {
    throw new Error(`the group object answered ${response.status} to drop`);
  }
}

// ---------------------------------------------------------------------------------------
// GET /oauth/patreon/callback
// ---------------------------------------------------------------------------------------

/**
 * Where Patreon sends the reader after they consent: exchange the code, read the membership,
 * write the entitlement, and show one code to type into the app.
 *
 * **The `state` parameter is received and not checked, and that is worth saying out loud
 * rather than leaving as an absence.** The app mints `state` and opens the authorize URL, but
 * the redirect lands *here* rather than back in the app, so the app never sees it again and
 * nothing carries it to `/claim`. The relay cannot check it either — it holds no record of a
 * flow it did not start. What actually binds this page to the reader is that the claim code is
 * shown only to the browser session that completed the consent, is single-use, and expires in
 * ten minutes.
 */
export async function handleCallback(request: Request, env: Env): Promise<Response> {
  const code = new URL(request.url).searchParams.get("code");
  if (code === null || code === "") {
    return page("Patreon sent no authorization code", "Start again from the app.", 400);
  }

  // **The bindings are asked for here, ahead of the `try` below, and that ordering is the
  // point.** Everything inside the exchange is caught and rendered as "try again in a minute",
  // which is the right sentence for a Patreon outage and exactly the wrong one for a relay
  // deployed without its client secret — a reader would retry that for ever. `required`
  // throwing out here is a 500 that names the binding in the Worker's log.
  required(env.RELAY_BASE, "RELAY_BASE");
  required(env.PATREON_CLIENT_ID, "PATREON_CLIENT_ID");
  required(env.PATREON_CLIENT_SECRET, "PATREON_CLIENT_SECRET");
  required(env.PATREON_CAMPAIGN_ID, "PATREON_CAMPAIGN_ID");

  const connected = await connectPatreon(code, env);
  if (connected === null) {
    return page("Patreon could not be reached", "Try connecting again in a minute.", 502);
  }
  const { identity, refreshToken } = connected;

  const now = Date.now();
  const existing = await env.DB.prepare(
    `SELECT subject, grace_until, group_id
       FROM entitlements
      WHERE source = 'patreon' AND external_id = ?`,
  )
    .bind(identity.userId)
    .first<{ subject: string; grace_until: number | null; group_id: string | null }>();

  const decision = decide(identity.patronStatus, now, existing?.grace_until ?? null);

  // `created_at` is written on the insert and never on the conflict: it is what the app shows
  // as "supporting since", and a reader who reconnects has not started supporting today.
  //
  // `grace_until` is written **unconditionally from the decision, `dead` included**. Leaving a
  // stale deadline behind is picked up by `decide` the next time the subject flaps to
  // `declined_patron`, and hands them a window that was already spent.
  //
  // `RETURNING subject` and not the bound parameter: the insert arm mints a uuid and the
  // conflict arm keeps the subject the row already had, so which of the two is the reader's is
  // not knowable from what was sent. Spec §5 makes that indirection the whole point — the
  // Patreon id lives in one column of one table and everything downstream names the subject —
  // so writing a claim code against the wrong one would hand a reader somebody else's grant.
  const upserted = await env.DB.prepare(
    `INSERT INTO entitlements
       (subject, source, external_id, status, grace_until, patreon_refresh, created_at, checked_at)
     VALUES (?, 'patreon', ?, ?, ?, ?, ?, ?)
     ON CONFLICT (source, external_id) DO UPDATE SET
       status = excluded.status,
       grace_until = excluded.grace_until,
       patreon_refresh = excluded.patreon_refresh,
       checked_at = excluded.checked_at
     RETURNING subject`,
  )
    .bind(
      existing?.subject ?? crypto.randomUUID(),
      identity.userId,
      decision.status,
      decision.graceUntil,
      refreshToken,
      now,
      now,
    )
    .first<{ subject: string }>();
  if (upserted === null) {
    return page("The relay could not record that membership", "Try again in a minute.", 500);
  }
  const subject = upserted.subject;

  if (decision.status === "dead") {
    // A reader who was serving and has since lapsed reaches §7.1 here rather than waiting for
    // a webhook that may never have been delivered. `existing === null` is somebody who has
    // never connected at all: the upsert already wrote them dead and there is no group to drop,
    // so there is nothing left to revoke. The drop must not stop the page rendering — the
    // reader is standing in front of it, and the daily pass will try again.
    try {
      if (existing !== null) await revoke(env, subject, existing.group_id);
    } catch (error) {
      console.error("callback revoke", error);
    }
    return page(
      "That Patreon account is not supporting",
      "Nothing on your devices has been touched. Start a pledge and connect again.",
    );
  }

  const claimCode = codeFrom(crypto.getRandomValues(new Uint8Array(CODE_CHARS)));
  await env.DB.prepare(`INSERT INTO claim_codes (code, subject, expires_at) VALUES (?, ?, ?)`)
    .bind(normaliseCode(claimCode), subject, now + CODE_TTL_MS)
    .run();

  return page(
    "You are connected",
    "Paste this into MTG Grimoire within ten minutes:",
    200,
    claimCode,
  );
}

/**
 * The two Patreon round trips the callback makes, as one answer or `null`.
 *
 * `null` folds three failures the reader can do nothing different about — Patreon unreachable,
 * Patreon refusing the code, Patreon answering a document with no user in it — into the one
 * sentence that fits all three. **It does not fold a missing binding**: the callback asks for
 * those ahead of this call, so a relay deployed without its client secret is a 500 that names
 * the binding rather than a "try again in a minute" a reader would retry for ever.
 */
async function connectPatreon(
  code: string,
  env: Env,
): Promise<{ identity: Identity; refreshToken: string } | null> {
  try {
    const tokens = await exchangeCode(code, env);
    const identity = await fetchIdentity(tokens.accessToken, env);
    if (identity === null) return null;
    return { identity, refreshToken: tokens.refreshToken };
  } catch (error) {
    console.error("patreon callback", error);
    return null;
  }
}

// ---------------------------------------------------------------------------------------
// POST /claim
// ---------------------------------------------------------------------------------------

/**
 * Trade the code the reader pasted for a grant, and bind the entitlement to their group.
 *
 * **A 401 here is a refusal of this press and not a lapse**, which is the distinction the app
 * depends on: `sync_engine::entitlement::claim` shows the sentence and clears nothing, where
 * the same status from `/token` means the membership is over and the grant is revoked. A reader
 * mistyping a code must not lose an entitlement they already hold.
 */
export async function handleClaim(request: Request, env: Env): Promise<Response> {
  let body: ClaimBody;
  try {
    body = (await request.json()) as ClaimBody;
  } catch {
    return json({ error: "unreadable body" }, 400);
  }
  if (typeof body?.code !== "string" || typeof body.group !== "string") {
    return json({ error: "malformed claim" }, 400);
  }

  // **`epoch` and `auth` are validated with exactly the care `group` is, and for the same
  // reason**: both are written to D1 by this handler and both are read back as credentials.
  //
  // `isSafeInteger` rather than `isInteger`, because `1e300` passes the latter and is the one
  // value a claim could carry that permanently bricks its own group: `epoch + 1 === epoch` up
  // there, so `recordRotation`'s `WHERE ? > max(epoch)` could never again be satisfied and no
  // removal would ever publish. An epoch is a removal counter starting at zero, so 2^53 is not
  // a ceiling any group reaches by living.
  if (typeof body.epoch !== "number" || !Number.isSafeInteger(body.epoch) || body.epoch < 0) {
    return json({ error: "malformed claim" }, 400);
  }
  // Unvalidated, this string reaches `equalsConstantTime` — whose length check is only *not* a
  // near-miss oracle because both sides are 64 hex characters by the time they get there — and
  // then a D1 write that fixes the group's credential until somebody rotates it.
  if (typeof body.auth !== "string" || !RELAY_AUTH.test(body.auth)) {
    return json({ error: "malformed claim" }, 400);
  }
  const { epoch, auth } = body;

  // A group id the router could never carry is refused before it is bound, not after. Bound, it
  // would mint tokens whose `grp` names a path segment `ROUTE` rejects — a claim that succeeds
  // and a sync that can never work.
  const group = body.group;
  if (!GROUP_ID.test(group)) return json({ error: "that is not a sync group id" }, 400);

  // Ahead of the code lookup, because that lookup *spends* the code: a body refused after the
  // `DELETE … RETURNING` has run costs the reader another trip through Patreon's consent page
  // for a field the relay could have read without touching D1 at all.
  const device = deviceIn(body);
  if (device === null) return json({ error: "that is not a device id" }, 400);

  const now = Date.now();

  // **`DELETE … RETURNING`, in one statement, is what makes the code single-use.** D1 has no
  // interactive transaction, so a read followed by a delete is two round trips with a window
  // between them, and two requests racing that window both see the code and both claim. One
  // statement is atomic by construction, and it carries the ten-minute expiry with it —
  // `claim_codes` enforces neither, which is why both live here.
  const claimed = await env.DB.prepare(
    `DELETE FROM claim_codes WHERE code = ? AND expires_at > ? RETURNING subject`,
  )
    .bind(normaliseCode(body.code), now)
    .first<{ subject: string }>();
  if (claimed === null) return json({ error: "that claim code is not valid" }, 401);

  const row = await env.DB.prepare(
    `SELECT subject, status, grace_until, group_id, refresh_secret, patreon_refresh, created_at
       FROM entitlements
      WHERE subject = ?`,
  )
    .bind(claimed.subject)
    .first<EntitlementRow>();
  if (row === null) return json({ error: "that membership no longer exists" }, 403);

  const status = settle(row.status, row.grace_until, now);
  if (status === "dead") return json({ error: "that membership is not active" }, 403);

  // **A subject that already holds a *different* group is rebound rather than refused, and this
  // reverses what this handler used to do (spec §3).** The 409 that stood here was a dead end
  // with no press that helped: the paying device leaves its group — which #307's departure makes
  // an ordinary thing to do — and its entitlement is still bound to the group it left, so the
  // next Connect is refused for ever and the only repair is a hand edit of D1.
  //
  // **The invariant the refusal was actually protecting is kept.** Trust-on-first-use existed to
  // stop one subscription serving two groups at once; *moving* a binding leaves the subject
  // serving exactly one. Only the first stops being the latest.
  //
  // ⚠️ **And it silently orphans whatever devices remain in the old group** — their manifest and
  // their log are gone and they fail their next key check. They are already orphaned when the
  // payer has left, but a reader who re-claims *without* leaving can do this to a working group
  // by accident, so `SyncPanel` says so beside the claim-code field before the press.
  const previous = row.group_id;

  // **The `WHERE` is a compare-and-swap on the binding this request read**, which is what the
  // trust-on-first-use clause becomes once a binding is allowed to move: `previous` rather than
  // `group`, so a second claim racing this one — onto any group, this one included — finds the
  // row already moved, changes nothing and is refused instead of overwriting the first's work.
  // Spelled `(group_id IS NULL OR group_id = ?)` because SQL's `=` is never true against a NULL,
  // and a first claim is exactly the case where `previous` is one.
  const refresh = row.refresh_secret ?? randomSecret();
  let bound: D1Result;
  try {
    bound = await env.DB.prepare(
      `UPDATE entitlements
          SET group_id = ?, refresh_secret = ?, status = ?, checked_at = ?
        WHERE subject = ? AND (group_id IS NULL OR group_id = ?)`,
    )
      .bind(group, refresh, status, now, row.subject, previous)
      .run();
  } catch {
    // `entitlements_group` is unique, so this is another *subject* holding that group id — a
    // shared subscription wearing two names, which is the thing that constraint is really about
    // and the one case the 409 still exists for. Reached by catching the failure rather than by
    // asking a question first: D1 has no interactive transaction, so a `SELECT` and then an
    // `UPDATE` is two round trips with a window between them.
    return json({ error: "that sync group is bound to another membership" }, 409);
  }
  if (bound.meta.changes === 0) {
    return json({ error: "that membership is already bound to another sync group" }, 409);
  }

  // **After the binding succeeded, so a refusal above tears nothing down.** See `releaseGroup`.
  if (previous !== null && previous !== group) await releaseGroup(env, previous);

  // **After the binding and never before.** Every refusal above leaves this group's key alone,
  // which is what a 409 has to mean: a claim that registered an auth for a group it did not bind
  // would hand the *next* device to claim that group a `group_auth` it cannot match, and no
  // amount of re-claiming would clear it — `seedGroup` is `INSERT OR IGNORE` precisely so that a
  // re-claim does not overwrite a live manifest.
  //
  // Allowed to throw. The alternative is answering a grant while the group's first auth was
  // never registered, which is a device that syncs today and cannot rotate ever; a 500 is the
  // loud version of the same failure and the reader's next press re-claims the same group,
  // because `row.group_id === group` by then.
  await seedGroup(env, group, epoch, auth);

  // **Last, because a claim issues a token and the cap is a fence around tokens (spec §4.2).**
  // A claim that registered nothing would hand a sixth device a grant here and 403 it at its
  // next `/token` a day later — a Connect that reported success and a sync that never worked.
  //
  // **And after `seedGroup` rather than before it**, which only matters on the one path that
  // reaches this refusal with the binding unchanged: re-claiming a group already holding five
  // devices from a wiped reinstall. Seeding first leaves that group able to rotate, which is how
  // the reader frees a slot and gets out; refusing ahead of it would leave a bound group with no
  // registered auth, and every retry would refuse in the same place for ever.
  if (!(await admitDevice(env, group, device, now))) return json({ error: GROUP_FULL, code: DEVICE_LIMIT }, 403);

  // Annotated rather than inferred, so a mis-spelled field is a type error here instead of a
  // serde failure in `sync_engine::entitlement` that no test on either side can see.
  const grant: Grant = {
    refresh,
    ...(await grantFor(env, row.subject, group, status, row.created_at)),
  };
  return json(grant);
}

/** The `/claim` body, before any of it has been checked. */
interface ClaimBody {
  code?: unknown;
  group?: unknown;
  epoch?: unknown;
  auth?: unknown;
  device?: unknown;
}

// ---------------------------------------------------------------------------------------
// POST /token
// ---------------------------------------------------------------------------------------

/**
 * Trade the long-lived refresh secret for a fresh access token.
 *
 * **A 401 here is a lapse**, and the app reads it as one: the grant is cleared and the panel
 * offers the connect button again. So every refusal on this route has to be a real one — which
 * is why a closed grace window is resolved here and not merely reported. A window closes with
 * nothing to announce it, and this is one of only two places that ever asks.
 *
 * **Which is also why the device cap is a 403 and is asked last.** Both doors admit their device
 * only once the entitlement has settled to something that would be served, so a membership on
 * its way to a 401 never spends one of the reader's five slots — and the reader who *is* serving
 * and has simply run out of devices is told that, rather than being told they had stopped paying.
 */
export async function handleToken(request: Request, env: Env): Promise<Response> {
  let body: TokenBody;
  try {
    body = (await request.json()) as TokenBody;
  } catch {
    return json({ error: "unreadable body" }, 400);
  }

  // **The shape is decided before anything is looked up, and `refresh` wins whenever it is
  // present at all.** Branching on presence rather than on validity is what stops a body
  // carrying both fields being steered onto the weaker door by sending a `refresh` the caller
  // knows is malformed: a caller who names a secret is answered about that secret or refused.
  if (body?.refresh !== undefined) {
    if (typeof body.refresh !== "string" || body.refresh === "") {
      return json({ error: "malformed refresh" }, 400);
    }
    // **Required on this door too, and it is the door it would be easiest to leave off.** The
    // device that pressed Connect never reaches the group door, so a `device` that were optional
    // here would leave the one device certainly signed in permanently uncounted — and would hand
    // every other caller a one-field way out of the cap besides.
    const device = deviceIn(body);
    if (device === null) return json({ error: "that is not a device id" }, 400);
    return refreshDoor(env, body.refresh, device);
  }

  if (typeof body?.group !== "string" || !GROUP_ID.test(body.group)) {
    return json({ error: "malformed token request" }, 400);
  }
  if (typeof body.auth !== "string" || !RELAY_AUTH.test(body.auth)) {
    return json({ error: "malformed token request" }, 400);
  }
  const device = deviceIn(body);
  if (device === null) return json({ error: "that is not a device id" }, 400);
  return groupDoor(env, body.group, body.auth, device);
}

/** The `/token` body, before any of it has been checked. Either shape arrives here. */
interface TokenBody {
  refresh?: unknown;
  group?: unknown;
  auth?: unknown;
  device?: unknown;
}

/**
 * The refresh door: the one device that pressed Connect, trading the Patreon-side secret.
 *
 * **Looked up by `refresh_secret`, and that column alone.** See this module's doc for why this
 * query and `groupDoor`'s are not one query with an `OR`.
 */
async function refreshDoor(env: Env, refresh: string, device: string): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT subject, status, grace_until, group_id, refresh_secret, patreon_refresh, created_at
       FROM entitlements
      WHERE refresh_secret = ?`,
  )
    .bind(refresh)
    .first<EntitlementRow>();

  // No row is a revoked or never-issued secret; a row with no group has never been claimed and
  // there is nothing to stamp into `grp`. Both are the same sentence to the app.
  if (row === null || row.group_id === null) return json({ error: "unauthorized" }, 401);

  const status = await serveOrRevoke(env, row);
  if (status === null) return json({ error: "unauthorized" }, 401);

  if (!(await admitDevice(env, row.group_id, device, Date.now()))) {
    return json({ error: GROUP_FULL, code: DEVICE_LIMIT }, 403);
  }

  // The caller's own string rather than `row.refresh_secret`: the same value, and the secret is
  // not rotated here — the app stores whatever comes back, and rotating on every refresh would
  // break a device that is refreshing concurrently.
  const grant: Grant = {
    refresh,
    ...(await grantFor(env, row.subject, row.group_id, status, row.created_at)),
  };
  return json(grant);
}

/**
 * The group door: any device that holds the group key, and therefore no Patreon secret at all.
 * Spec §2.2, and the whole of item 3 — a device that has only ever paired can mint its own token.
 *
 * **The auth is checked before the row is loaded, through `authIsCurrent` rather than a `WHERE
 * group_auth = ?`.** That helper is where the comparison is constant-time and where "current"
 * is defined; a second spelling of the question here would be a second thing to get wrong, and
 * an index probe on a secret besides. It costs one extra point read on `entitlements`, against
 * a route that is asked once a day per device.
 *
 * **The answer omits `refresh` and nothing here has one to omit.** `grantFor` is not given the
 * secret, so the omission is structural rather than a deletion somebody could forget.
 */
async function groupDoor(
  env: Env,
  group: string,
  auth: string,
  device: string,
): Promise<Response> {
  // A stale auth lands here after a rotation this device has not caught up with, which is not a
  // lapse — spec §2.5 has the app re-check `/keys` once before concluding anything from a 401 on
  // this door. The relay cannot tell the two apart and does not try: it answers the same
  // `unauthorized` to a device that is behind and to one that was removed.
  if (!(await authIsCurrent(env, group, auth))) return json({ error: "unauthorized" }, 401);

  const row = await env.DB.prepare(
    `SELECT subject, status, grace_until, group_id, refresh_secret, patreon_refresh, created_at
       FROM entitlements
      WHERE group_id = ?`,
  )
    .bind(group)
    .first<EntitlementRow>();
  // Unreachable while `authIsCurrent` reads `entitlements.group_auth` — no row is no auth. Kept
  // because the day that helper is taught to read `group_keys` instead, this line is the only
  // thing standing between a group with no membership and a token (spec §2.4).
  if (row === null) return json({ error: "unauthorized" }, 401);

  const status = await serveOrRevoke(env, row);
  if (status === null) return json({ error: "unauthorized" }, 401);

  // **A device that inherited its sign-in from another grouped device is counted like any other,
  // which is item 3 of the request in the reader's own words.** This is the only door such a
  // device ever reaches.
  if (!(await admitDevice(env, group, device, Date.now()))) {
    return json({ error: GROUP_FULL, code: DEVICE_LIMIT }, 403);
  }

  const grant: GroupGrant = await grantFor(env, row.subject, group, status, row.created_at);
  return json(grant);
}

/**
 * What a stored row is worth *now*, or `null` for "refuse" — and the revocation that a refusal
 * on this route has to carry with it.
 *
 * **One function so that both doors settle identically, which is a requirement rather than
 * tidiness.** A closed grace window is resolved on the group door exactly as on the refresh
 * door (spec §2.2): `/token` is one of only two places that ever asks whether a window has run
 * out, and a group door that merely reported it would leave a declined reader's every paired
 * device syncing for ever on a membership that ended a week ago.
 *
 * §7.1 runs here rather than being left to tomorrow's cron, because the alternative is a row
 * this pass has already decided is dead whose log nothing will ever drop — the reconciliation
 * skips `dead` rows by design. A failure must not change the answer: the token is refused either
 * way, and the cron's local settle will try again.
 */
async function serveOrRevoke(env: Env, row: EntitlementRow): Promise<Status | null> {
  const now = Date.now();
  const status = settle(row.status, row.grace_until, now);
  if (status === "dead") {
    try {
      await revoke(env, row.subject, row.group_id);
    } catch (error) {
      console.error("token revoke", error);
    }
    return null;
  }

  await env.DB.prepare(`UPDATE entitlements SET checked_at = ? WHERE subject = ?`)
    .bind(now, row.subject)
    .run();
  return status;
}

// ---------------------------------------------------------------------------------------
// POST /webhook/patreon
// ---------------------------------------------------------------------------------------

/**
 * Patreon telling us a membership changed. The primary signal; the cron is the backstop.
 *
 * **The signature is checked before the body is read as anything but text**, and an unverified
 * body is refused with 401 without being parsed at all. An unverified `members:pledge:delete`
 * deletes a reader's log, which is the one failure in this design that destroys data.
 *
 * Everything that is not a refusal answers `204`, including a body about somebody who never
 * connected. Patreon retries a non-2xx, and retrying a message we will never act on is a loop
 * with no exit.
 */
export async function handleWebhook(request: Request, env: Env): Promise<Response> {
  // Once, as text. Re-serialising the parsed JSON changes the bytes the signature covers.
  const body = await request.text();
  const signature = request.headers.get("x-patreon-signature");
  const secret = required(env.PATREON_WEBHOOK_SECRET, "PATREON_WEBHOOK_SECRET");
  if (!verifyWebhook(body, signature, secret)) {
    return new Response("unauthorized", { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response("unreadable body", { status: 400 });
  }

  const member = readMember(payload);
  if (member === null) return new Response(null, { status: 204 });

  const row = await env.DB.prepare(
    `SELECT subject, grace_until, group_id
       FROM entitlements
      WHERE source = 'patreon' AND external_id = ?`,
  )
    .bind(member.userId)
    .first<{ subject: string; grace_until: number | null; group_id: string | null }>();
  if (row === null) return new Response(null, { status: 204 });

  const now = Date.now();

  // **A `pledge:delete` is dead whatever the payload's `patron_status` says**, and the event
  // is read rather than the attribute because the two answer different questions: the event
  // names what happened, while the attribute is a snapshot of a membership that is in the act
  // of being removed. Spec §7.1 makes `pledge:delete` dead immediately, so trusting the
  // attribute alone would leave a cancelled reader serving on any payload that still reads
  // `active_patron` — a possibility nothing here has ruled out, on a path where being wrong
  // costs a free subscription until the next daily pass.
  const event = request.headers.get("x-patreon-event") ?? "";
  const decision = event.endsWith(":delete")
    ? { status: "dead" as Status, graceUntil: null }
    : decide(member.patronStatus, now, row.grace_until);

  await env.DB.prepare(
    `UPDATE entitlements SET status = ?, grace_until = ?, checked_at = ? WHERE subject = ?`,
  )
    .bind(decision.status, decision.graceUntil, now, row.subject)
    .run();

  // Allowed to throw: Patreon retries a non-2xx and every statement above is idempotent, so a
  // failed drop gets a second attempt rather than leaving a dead subject's log on the relay.
  if (decision.status === "dead") await revoke(env, row.subject, row.group_id);

  return new Response(null, { status: 204 });
}

// ---------------------------------------------------------------------------------------
// The daily reconciliation
// ---------------------------------------------------------------------------------------

/**
 * The cron's work: re-ask Patreon about every subject that is not already dead, and close the
 * grace windows that have run out.
 *
 * **Two things only this pass can catch.** A webhook Patreon failed to deliver would otherwise
 * leave a cancelled membership syncing for ever; and a grace window closing is not an event at
 * all — nothing happens on the seventh day, so nothing fires.
 *
 * **Keyset paging, not `LIMIT/OFFSET`.** The window is `status <> 'dead'` and this pass writes
 * rows *to* dead, so under `OFFSET` the surviving rows shift left underneath it and every page
 * boundary skips one. Ordering by the primary key and asking for what is after the last subject
 * seen cannot skip.
 *
 * A row that fails is logged and the pass continues: one reader's revoked OAuth grant must not
 * stop everybody else's reconciliation.
 */
export async function reconcile(env: Env): Promise<void> {
  let after = "";

  for (let page = 0; page < RECONCILE_PAGES; page += 1) {
    const rows = (
      await env.DB.prepare(
        `SELECT subject, status, grace_until, group_id, refresh_secret, patreon_refresh, created_at
           FROM entitlements
          WHERE status <> 'dead' AND subject > ?
          ORDER BY subject
          LIMIT ?`,
      )
        .bind(after, RECONCILE_PAGE)
        .all<EntitlementRow>()
    ).results;
    if (rows.length === 0) return;

    for (const row of rows) {
      try {
        await reconcileOne(env, row);
      } catch (error) {
        console.error(`reconcile ${row.subject}`, error);
      }
    }

    after = rows[rows.length - 1].subject;
    if (rows.length < RECONCILE_PAGE) return;
  }
}

/**
 * One row: refresh the reader's Patreon token, re-read the membership, decide, apply.
 *
 * **A row with no stored Patreon token still gets its window settled.** There is nothing to ask
 * Patreon with, but the question a closing grace window asks is local, and skipping such a row
 * entirely would leave a declined reader in an open window for ever.
 *
 * **An unreadable identity document throws rather than deciding.** `decide(null, …)` is `dead`,
 * and that is right for a reader Patreon says has no membership — but a document this code
 * cannot parse is the *absence* of an answer, and turning that into a cancellation is how one
 * shape change on Patreon's side becomes a mass revocation in a job nobody is watching.
 */
async function reconcileOne(env: Env, row: EntitlementRow): Promise<void> {
  const now = Date.now();

  if (row.patreon_refresh === null || row.patreon_refresh === "") {
    if (settle(row.status, row.grace_until, now) === "dead") {
      await revoke(env, row.subject, row.group_id);
    }
    return;
  }

  const tokens = await refreshTokens(row.patreon_refresh, env);
  const identity = await fetchIdentity(tokens.accessToken, env);
  if (identity === null) {
    throw new Error("patreon answered an identity document with no user id");
  }

  const decision = decide(identity.patronStatus, now, row.grace_until);
  await env.DB.prepare(
    `UPDATE entitlements
        SET status = ?, grace_until = ?, patreon_refresh = ?, checked_at = ?
      WHERE subject = ?`,
  )
    .bind(decision.status, decision.graceUntil, tokens.refreshToken, now, row.subject)
    .run();

  if (decision.status === "dead") await revoke(env, row.subject, row.group_id);
}

// ---------------------------------------------------------------------------------------
// The landing page
// ---------------------------------------------------------------------------------------

/**
 * The one page this relay renders. Self-contained by necessity — a Worker response has no
 * asset pipeline behind it — and deliberately plain: it exists to be read once and copied from.
 *
 * Nothing interpolated here is attacker-supplied. `code` comes from `codeFrom`, whose output is
 * twelve characters of a thirty-two character alphabet plus two hyphens, and the headings and
 * bodies are literals in this file. **A future edit that renders anything off the request must
 * escape it**; there is no template engine standing between this string and the browser.
 */
function page(heading: string, body: string, status = 200, code?: string): Response {
  const shown =
    code === undefined
      ? ""
      : `<p class="code" role="status" aria-label="Your claim code">${code}</p>`;

  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MTG Grimoire</title>
<style>
  :root { color-scheme: light dark; --ink: #17171a; --paper: #fbfbfd; --dim: #55555e; }
  @media (prefers-color-scheme: dark) {
    :root { --ink: #f2f2f5; --paper: #131316; --dim: #a0a0aa; }
  }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: var(--paper); color: var(--ink);
         font: 16px/1.55 ui-sans-serif, system-ui, "Segoe UI", sans-serif; }
  main { max-width: 32rem; padding: 2rem 1.5rem; text-align: center; }
  h1 { font-size: 1.4rem; margin: 0 0 0.75rem; }
  p { margin: 0 0 1rem; color: var(--dim); }
  .code { font: 700 clamp(1.5rem, 7vw, 2.4rem)/1.2 ui-monospace, "Cascadia Mono", monospace;
          letter-spacing: 0.12em; color: var(--ink); word-break: break-all; }
</style></head>
<body><main><h1>${heading}</h1><p>${body}</p>${shown}</main></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
