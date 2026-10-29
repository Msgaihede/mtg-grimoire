import { bounded, MAX_GZIP_BYTES } from "./body";
import { bearerOf, decodeClaims } from "./consumer";
import {
  allowedOrigin,
  DIGEST_HEADER,
  HLC_CTR_HEADER,
  HLC_MS_HEADER,
  preflight,
  withCors,
} from "./cors";
import { GROUP_SEGMENT, json, refuse, storeOf, type Env } from "./env";
import { authorised } from "./gate";
import {
  BAD_ACK,
  BAD_CONSUMER,
  INTEGRATIONS,
  INTENT_TOO_LARGE,
  isIntegration,
  MAX_INTENT_BYTES,
  parseAck,
  parseConsumerRequest,
  type Integration,
} from "./intents";
import { remember, sweepLapsed } from "./lapse";
import { isTable, MARKETPLACES, parseSettings, TABLES, type Table } from "./projection";
import { importKek } from "./seal";
import { BAD_PROJECTION, NO_STORE, PROJECTION_LIMIT, type ConsumerCall } from "./store";

/**
 * The integrations Worker's router — `index.ts` exports it beside the `GroupStore` class, and the
 * suite drives it as `worker.fetch(request, env)` with no workerd (`vitest.config.ts`'s choice,
 * the share Worker's reasons). The PR 2 plan's §3.2 and the PR 3 plan's §3.2–3.3 are the table it
 * answers:
 *
 * | Route | Answers |
 * | --- | --- |
 * | `GET /g/{group}/projection/digests` | 200 the settings and each table's digest; 404 `no_store` |
 * | `PUT /g/{group}/settings` | 200 `{ fields, marketplace, created }`; with `create`, makes the store if there is none, and without it 404 `no_store` |
 * | `PUT /g/{group}/projection/{table}` | 200; 404 `no_store`; 409 `stale_projection` or `settings_mismatch`; 413 `projection_limit`; 400 `bad_projection` |
 * | `DELETE /g/{group}` | 204, whether or not there was a store |
 * | `GET /g/{group}/intents` | 200 the pending intents; 404 `no_store` |
 * | `POST /g/{group}/intents/{id}/claim` | 200 a lease; 409 `claimed` or `already_acked`; 404 `no_intent` |
 * | `POST /g/{group}/intents/{id}/ack` | 200; 409 `claimed` or `already_acked`; 400 `bad_ack`; 404 `no_intent` |
 * | `GET /g/{group}/consumers` | 200 the tokens live, without the tokens |
 * | `POST /g/{group}/consumers/{integration}` | 200 a token; 400 `bad_consumer`; 404 `no_store` |
 * | `DELETE /g/{group}/consumers/{integration}` | 204 |
 * | `GET /c/collection`, `/c/wishlist`, `/c/decks`, `/c/decks/{uid}`, `/c/folders`, `/c/autocomplete` | the projection, overlaid; 401; 403 `scope` |
 * | `POST /c/intents`, `GET /c/intents/{id}` | an intent; 400 `bad_intent`; 403 `scope`; 413 `intent_too_large`; 429 `intent_quota` |
 *
 * **Two doors, and no route behind neither.** `/g/…` is a device's: a relay token, through the
 * gate. `/c/…` is an integration's: a consumer token the group's object minted and verifies — the
 * router reads its claims only to know which object to ask, and a token whose claims do not parse
 * is a 401 that reaches none. A relay token opens no `/c/` route and a consumer token no `/g/`
 * one (the spec's §6.3). The order of the checks is the share Worker's: the path, then the method
 * (405 before 401 — a fact about the request that costs nothing, where an HMAC verify does not),
 * then the KEK, then the door, then whatever the route costs.
 */

/** A store's routes. A `table` outside the six is no route. */
const DIGESTS = new RegExp(`^/g/(${GROUP_SEGMENT})/projection/digests$`);
const SETTINGS = new RegExp(`^/g/(${GROUP_SEGMENT})/settings$`);
const PROJECTION = new RegExp(`^/g/(${GROUP_SEGMENT})/projection/(${TABLES.join("|")})$`);
const GROUP = new RegExp(`^/g/(${GROUP_SEGMENT})$`);

/** An intent id: 16 random bytes, base64url (`intents.ts`'s `RANDOM_ID`). */
const ID_SEGMENT = "[A-Za-z0-9_-]{22}";

/** A projected row's uid, in a path or a `folder` parameter — a `sync_uid`'s alphabet, bounded. */
const UID_SEGMENT = "[A-Za-z0-9_-]{1,128}";
const UID = new RegExp(`^${UID_SEGMENT}$`);

/** The inbox's and the consumer tokens' device routes. An integration outside the list is no route. */
const INTENTS = new RegExp(`^/g/(${GROUP_SEGMENT})/intents$`);
const CLAIM = new RegExp(`^/g/(${GROUP_SEGMENT})/intents/(${ID_SEGMENT})/claim$`);
const ACK = new RegExp(`^/g/(${GROUP_SEGMENT})/intents/(${ID_SEGMENT})/ack$`);
const CONSUMERS = new RegExp(`^/g/(${GROUP_SEGMENT})/consumers$`);
const CONSUMER = new RegExp(`^/g/(${GROUP_SEGMENT})/consumers/(${INTEGRATIONS.join("|")})$`);

/** The consumer routes. */
const C_ENTRIES = /^\/c\/(collection|wishlist)$/;
const C_DECKS = /^\/c\/decks$/;
const C_DECK = new RegExp(`^/c/decks/(${UID_SEGMENT})$`);
const C_FOLDERS = /^\/c\/folders$/;
const C_AUTOCOMPLETE = /^\/c\/autocomplete$/;
const C_INTENTS = /^\/c\/intents$/;
const C_INTENT = new RegExp(`^/c/intents/(${ID_SEGMENT})$`);

/** A device's route: the group its path names, behind the gate. */
type DeviceRoute = { door: "device"; group: string; methods: readonly string[] } & (
  | { kind: "digests" }
  | { kind: "settings" }
  | { kind: "projection"; table: Table }
  | { kind: "delete" }
  | { kind: "intents" }
  | { kind: "claim"; id: string }
  | { kind: "ack"; id: string }
  | { kind: "consumers" }
  | { kind: "consumer"; integration: Integration }
);

/** An integration's route: the call its object answers once the token holds. */
type ConsumerRoute = {
  door: "consumer";
  methods: readonly string[];
  call: (request: Request, url: URL) => Promise<ConsumerCall | Response>;
};

type Route = DeviceRoute | ConsumerRoute;

const GET = ["GET"] as const;
const POST = ["POST"] as const;

function match(path: string): Route | null {
  let found: RegExpExecArray | null;
  const device = (group: string, methods: readonly string[]) => ({
    door: "device" as const,
    group,
    methods,
  });
  if ((found = DIGESTS.exec(path)) !== null) {
    return { ...device(found[1], GET), kind: "digests" };
  }
  if ((found = SETTINGS.exec(path)) !== null) {
    return { ...device(found[1], ["PUT"]), kind: "settings" };
  }
  if ((found = PROJECTION.exec(path)) !== null && isTable(found[2])) {
    return { ...device(found[1], ["PUT"]), kind: "projection", table: found[2] };
  }
  if ((found = GROUP.exec(path)) !== null) {
    return { ...device(found[1], ["DELETE"]), kind: "delete" };
  }
  if ((found = INTENTS.exec(path)) !== null) {
    return { ...device(found[1], GET), kind: "intents" };
  }
  if ((found = CLAIM.exec(path)) !== null) {
    return { ...device(found[1], POST), kind: "claim", id: found[2] };
  }
  if ((found = ACK.exec(path)) !== null) {
    return { ...device(found[1], POST), kind: "ack", id: found[2] };
  }
  if ((found = CONSUMERS.exec(path)) !== null) {
    return { ...device(found[1], GET), kind: "consumers" };
  }
  if ((found = CONSUMER.exec(path)) !== null && isIntegration(found[2])) {
    return { ...device(found[1], ["POST", "DELETE"]), kind: "consumer", integration: found[2] };
  }
  return matchConsumer(path);
}

function matchConsumer(path: string): ConsumerRoute | null {
  let found: RegExpExecArray | null;
  const consumer = (methods: readonly string[], call: ConsumerRoute["call"]): ConsumerRoute => ({
    door: "consumer",
    methods,
    call,
  });
  if ((found = C_ENTRIES.exec(path)) !== null) {
    const table = found[1] === "collection" ? "collection_entries" : "wishlist_entries";
    return consumer(GET, async (_request, url) => {
      const q = query(url, "q");
      const folder = url.searchParams.get("folder");
      if (typeof q !== "string" && q !== null) return q;
      if (folder !== null && !UID.test(folder)) return badQuery("folder is a folder's uid");
      return { op: "entries", table, q, folder };
    });
  }
  if (C_DECKS.test(path)) {
    return consumer(GET, async (_request, url) => {
      const q = query(url, "q");
      return typeof q === "string" || q === null ? { op: "decks", q } : q;
    });
  }
  if ((found = C_DECK.exec(path)) !== null) {
    const uid = found[1];
    return consumer(GET, async () => ({ op: "deck", uid }));
  }
  if (C_FOLDERS.test(path)) return consumer(GET, async () => ({ op: "folders" }));
  if (C_AUTOCOMPLETE.test(path)) {
    return consumer(GET, async (_request, url) => {
      const kind = url.searchParams.get("kind");
      if (kind !== "collection" && kind !== "wishlist" && kind !== "decks" && kind !== "folders") {
        return badQuery("kind is one of collection, wishlist, decks, folders");
      }
      const q = query(url, "q");
      return typeof q === "string" || q === null ? { op: "autocomplete", kind, q } : q;
    });
  }
  if (C_INTENTS.test(path)) {
    return consumer(POST, async (request) => {
      const read = await readJson(request, MAX_INTENT_BYTES);
      if ("over" in read) {
        return refuse(
          413,
          `an intent may be at most ${MAX_INTENT_BYTES} bytes, and that one is ${read.over}`,
          INTENT_TOO_LARGE,
        );
      }
      return { op: "post", body: read.value };
    });
  }
  if ((found = C_INTENT.exec(path)) !== null) {
    const id = found[1];
    return consumer(GET, async () => ({ op: "intent", id }));
  }
  return null;
}

/**
 * A consumer route's query that is not one it takes — a search longer than {@link MAX_QUERY_CHARS},
 * a `folder` that is no uid, an autocomplete `kind` outside its four. Not a code the plan lists:
 * nothing on a device reads it, and an integration shows its sentence.
 */
const BAD_QUERY = "bad_query";

/** The longest search a consumer route takes (plan §3.3). */
const MAX_QUERY_CHARS = 100;

const badQuery = (error: string) => refuse(400, error, BAD_QUERY);

/** A search parameter: its text, `null` when absent or blank, or the 400 for one too long. */
function query(url: URL, name: string): string | null | Response {
  const value = url.searchParams.get(name);
  if (value === null || value.trim() === "") return null;
  if (value.length > MAX_QUERY_CHARS) {
    return badQuery(`${name} is at most ${MAX_QUERY_CHARS} characters`);
  }
  return value;
}

/**
 * A JSON body under `cap`, counted as it arrives: its value — `undefined` for none or for one that
 * is not JSON, which the parser it goes to refuses in its own words — or the size that put it over.
 * A declared `content-length` over the cap is believed, and refused unread.
 */
async function readJson(
  request: Request,
  cap: number,
): Promise<{ value: unknown } | { over: number }> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) return { over: declared };
  if (request.body === null) return { value: undefined };
  const { bytes, size } = await bounded(request.body, cap);
  if (bytes === null) return { over: size };
  try {
    return { value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { value: undefined };
  }
}

/** A settings body is `{ fields, marketplace, create }`; anything past this size is not one. */
const MAX_SETTINGS_BYTES = 4096;

/** The refusal code of a settings body that is not `{ fields: IntegrationFields }`. */
const BAD_SETTINGS = "bad_settings";

/**
 * A watermark header: a non-negative safe integer in decimal, or `null`. Digits only — `1e3`,
 * `-0`, ` 7` and `0x10` are refused rather than read the way `Number` would read them.
 */
function counter(value: string | null): number | null {
  if (value === null || !/^\d{1,16}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** The document's digest: lowercase hex SHA-256, as the Rust writes it. */
const DIGEST = /^[0-9a-f]{64}$/;

function tooLarge(size: number): Response {
  return refuse(
    413,
    `that projection is ${size} bytes gzipped and a table may be at most ${MAX_GZIP_BYTES}`,
    PROJECTION_LIMIT,
  );
}

/** `GET /g/{group}/projection/digests` — the store's policy and tables, or "off". */
async function handleDigests(env: Env, group: string): Promise<Response> {
  const digests = await storeOf(env, group).digests(group);
  return digests === null
    ? refuse(404, "integrations are off for this group", NO_STORE)
    : json(digests);
}

/**
 * `PUT /g/{group}/settings` — make the store, or change its settings (the field policy and the
 * marketplace). `{ "fields": IntegrationFields, "marketplace": "<id>", "create": boolean }`, those
 * three keys exactly, answered `{ fields, marketplace, created }`.
 *
 * **`create: false` makes nothing**: on a group with no store it is `404 no_store`, and writes
 * neither the object nor the D1 row — a change of settings from a device that has not heard of
 * another's switch-off must not bring the store back.
 *
 * **With `create: true` the `integration_groups` row is written before the object and again after
 * it**, idempotently
 * both times. Before: a row with no store behind it costs the lapse pass an empty `deleteAll`,
 * while a store with no row is one it would never find. After: a switch-off that landed between
 * the first write and the object — its `deleteAll` first, then this store made, then its delete
 * of the row — would otherwise leave a store with no row (the review of 2026-10-25), which no
 * lapse could ever empty. `handleDelete` and the lapse pass hold the other side of the same race.
 */
async function handleSettings(
  request: Request,
  env: Env,
  group: string,
  now: number,
): Promise<Response> {
  if (request.body === null) return refuse(400, "that request carried no settings", BAD_SETTINGS);
  const { bytes } = await bounded(request.body, MAX_SETTINGS_BYTES);
  let body: unknown;
  try {
    body = bytes === null ? null : JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    body = null;
  }
  const settings = parseSettings(body);
  if (settings === null) {
    return refuse(
      400,
      `settings are { fields: { condition, lang, value, tags, notes }, marketplace: one of ${MARKETPLACES.join(", ")}, create }`,
      BAD_SETTINGS,
    );
  }
  const { create, ...wanted } = settings;

  if (create) await remember(env.DB, group, now);
  const answer = await storeOf(env, group).settings(group, wanted, create, now);
  if (answer === null) return refuse(404, "integrations are off for this group", NO_STORE);
  if (create) await remember(env.DB, group, now);
  return json(answer);
}

/**
 * `PUT /g/{group}/projection/{table}` — the headers, then the size as declared, then the size as
 * counted; everything after that is the store's (`store.ts`'s `replace`), which inflates, holds
 * the document to the format and the policy, and writes.
 */
async function handleProjection(
  request: Request,
  env: Env,
  group: string,
  table: Table,
  now: number,
): Promise<Response> {
  const ms = counter(request.headers.get(HLC_MS_HEADER));
  const ctr = counter(request.headers.get(HLC_CTR_HEADER));
  const digest = request.headers.get(DIGEST_HEADER) ?? "";
  if (ms === null || ctr === null) {
    return refuse(400, "that projection carried no watermark", BAD_PROJECTION);
  }
  if (!DIGEST.test(digest)) {
    return refuse(400, "that projection carried no digest", BAD_PROJECTION);
  }

  // Believed when it refuses, never when it admits: `bounded` counts what actually arrives.
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_GZIP_BYTES) return tooLarge(declared);
  if (request.body === null)
    return refuse(400, "that request carried no projection", BAD_PROJECTION);
  const { bytes, size } = await bounded(request.body, MAX_GZIP_BYTES);
  if (bytes === null) return tooLarge(size);

  const answer = await storeOf(env, group).replace(group, table, bytes, { ms, ctr }, digest, now);
  return json(answer.body, answer.status);
}

/**
 * `DELETE /g/{group}` — integrations off: the object emptied, then its row forgotten. 204 either
 * way, so a device that switches off twice, or switches off a group that never switched on, is
 * told the same thing: there is nothing on the server.
 *
 * **Then the object is asked again**, and a store found there gets its row back: another device
 * switched integrations on between this `deleteAll` and this delete of the row, and its store
 * must stay where the lapse pass can find it (`handleSettings` holds the race's other side).
 */
async function handleDelete(env: Env, group: string, now: number): Promise<Response> {
  const store = storeOf(env, group);
  await store.deleteAll();
  await env.DB.prepare(`DELETE FROM integration_groups WHERE group_id = ?`).bind(group).run();
  if (await store.exists()) await remember(env.DB, group, now);
  return new Response(null, { status: 204 });
}

/**
 * `GET /g/{group}/intents?since=` — the pending intents, oldest first. `since` is Unix ms, digits
 * only (`counter`'s rule); absent is every pending intent.
 */
async function handleIntents(request: Request, env: Env, group: string): Promise<Response> {
  const raw = new URL(request.url).searchParams.get("since");
  const since = raw === null ? null : counter(raw);
  if (raw !== null && since === null) return badQuery("since is Unix milliseconds");
  const pending = await storeOf(env, group).pendingIntents(group, since);
  return pending === null
    ? refuse(404, "integrations are off for this group", NO_STORE)
    : json(pending);
}

/** A device's small JSON body — an ack, a mint — under this many bytes. */
const MAX_DEVICE_BODY_BYTES = 4096;

/** `POST /g/{group}/intents/{id}/ack` — the body checked here, the outcome decided by the store. */
async function handleAck(
  request: Request,
  env: Env,
  group: string,
  id: string,
  now: number,
): Promise<Response> {
  const read = await readJson(request, MAX_DEVICE_BODY_BYTES);
  const ack = "over" in read ? null : parseAck(read.value);
  if (ack === null) {
    return refuse(
      400,
      "an ack is { state: applied | refused, reason, lease, hlcMs, hlcCtr }: applied with its lease and watermark, refused with a reason",
      BAD_ACK,
    );
  }
  const answer = await storeOf(env, group).ackIntent(group, id, ack, now);
  return json(answer.body, answer.status);
}

/**
 * `/g/{group}/consumers/{integration}` — `POST` mints the integration's token under
 * `{ scopes, days }`, replacing any it held; `DELETE` revokes it, 204 whether or not there was one.
 */
async function handleConsumer(
  request: Request,
  env: Env,
  group: string,
  integration: Integration,
  now: number,
): Promise<Response> {
  const store = storeOf(env, group);
  if (request.method === "DELETE") {
    await store.revokeConsumer(group, integration);
    return new Response(null, { status: 204 });
  }
  const read = await readJson(request, MAX_DEVICE_BODY_BYTES);
  const grant = "over" in read ? null : parseConsumerRequest(read.value);
  if (grant === null) {
    return refuse(
      400,
      "a token is asked for as { scopes: [collection:read | wishlist:read | decks:read | collection:add | wishlist:add], days: 1 to 365 }",
      BAD_CONSUMER,
    );
  }
  const answer = await store.mintConsumer(group, integration, grant, now);
  return json(answer.body, answer.status);
}

/** The 405 for a method the route does not take, naming the ones it does. */
function notAllowed(methods: readonly string[]): Response {
  return new Response(JSON.stringify({ error: "method not allowed", code: "method_not_allowed" }), {
    status: 405,
    headers: { "content-type": "application/json", allow: methods.join(", ") },
  });
}

async function route(request: Request, env: Env, found: Route): Promise<Response> {
  if (!found.methods.includes(request.method)) return notAllowed(found.methods);
  // **The KEK before the door**, so a deploy without it is a 500 naming it to a request with no
  // token at all — the tell the relay's signing key gives through the gate to a request with a
  // bad one, and what the README's check and the release's probe read. Imported and dropped: the object imports its
  // own, and this costs one key import on a request that is about to verify an HMAC anyway.
  await importKek(env.INTEGRATIONS_KEK, "INTEGRATIONS_KEK");
  return found.door === "device" ? device(request, env, found) : consumer(request, env, found);
}

/** A device's route, behind the gate. */
async function device(request: Request, env: Env, found: DeviceRoute): Promise<Response> {
  if (!(await authorised(request, env, found.group))) {
    return refuse(401, "unauthorized", "unauthorized");
  }

  // One clock read for the request, handed down: a store's `created_at` and its first table's
  // `published_at` are then the same instant, not two a millisecond apart.
  const now = Date.now();
  switch (found.kind) {
    case "digests":
      return handleDigests(env, found.group);
    case "settings":
      return handleSettings(request, env, found.group, now);
    case "projection":
      return handleProjection(request, env, found.group, found.table, now);
    case "delete":
      return handleDelete(env, found.group, now);
    case "intents":
      return handleIntents(request, env, found.group);
    case "claim": {
      const answer = await storeOf(env, found.group).claimIntent(found.group, found.id, now);
      return json(answer.body, answer.status);
    }
    case "ack":
      return handleAck(request, env, found.group, found.id, now);
    case "consumers": {
      const answer = await storeOf(env, found.group).listConsumers(found.group);
      return json(answer.body, answer.status);
    }
    case "consumer":
      return handleConsumer(request, env, found.group, found.integration, now);
  }
}

/**
 * An integration's route: **the token's claims, read and not trusted, name the object**; the
 * object verifies the token and answers. A bearer that is not a consumer token at all — a relay
 * token among them — is a 401 that reaches no object. The route's own refusals that need no store
 * (a search too long, an intent too large) come after that and before the object.
 */
async function consumer(request: Request, env: Env, found: ConsumerRoute): Promise<Response> {
  const bearer = bearerOf(request);
  const claims = bearer === null ? null : decodeClaims(bearer);
  if (bearer === null || claims === null) return refuse(401, "unauthorized", "unauthorized");
  const call = await found.call(request, new URL(request.url));
  if (call instanceof Response) return call;
  const answer = await storeOf(env, claims.grp).consumer(claims.grp, bearer, call, Date.now());
  return json(answer.body, answer.status);
}

export default {
  /**
   * **A path that is no route is a 404 with no CORS header**, as the scan inbox answers one; a
   * route answers a pre-flight from an allowed origin before the gate and the store, and every
   * other answer — the refusals above all — is made readable to the page that asked. A request
   * with no `Origin` gets the router's own `Response`, untouched.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const found = match(new URL(request.url).pathname);
    if (found === null) return refuse(404, "not found", "not_found");

    const origin = allowedOrigin(request, env);
    if (origin === null) return route(request, env, found);
    return (
      preflight(request, origin, found.methods.join(", ")) ??
      withCors(await route(request, env, found), origin)
    );
  },

  /**
   * The daily lapse pass (`lapse.ts`), fired by `wrangler.jsonc`'s cron. Awaited rather than
   * handed to `ctx.waitUntil`, so a pass that throws is reported against the invocation that
   * caused it — and `ctx` is absent from the signature for the share Worker's reason.
   */
  async scheduled(_controller: ScheduledController, env: Env) {
    await sweepLapsed(env);
  },
} satisfies ExportedHandler<Env>;

export type { Env };
