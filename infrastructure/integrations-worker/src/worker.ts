import { bounded, MAX_GZIP_BYTES } from "./body";
import {
  allowedOrigin,
  DIGEST_HEADER,
  HLC_CTR_HEADER,
  HLC_MS_HEADER,
  preflight,
  withCors,
} from "./cors";
import { json, refuse, storeOf, type Env } from "./env";
import { authorised } from "./gate";
import { remember, sweepLapsed } from "./lapse";
import { isTable, MARKETPLACES, parseSettings, TABLES, type Table } from "./projection";
import { importKek } from "./seal";
import { BAD_PROJECTION, NO_STORE, PROJECTION_LIMIT } from "./store";

/**
 * The integrations Worker's router — `index.ts` exports it beside the `GroupStore` class, and the
 * suite drives it as `worker.fetch(request, env)` with no workerd (`vitest.config.ts`'s choice,
 * the share Worker's reasons). Plan §3.2 is the table it answers:
 *
 * | Route | Answers |
 * | --- | --- |
 * | `GET /g/{group}/projection/digests` | 200 the settings and each table's digest; 404 `no_store` |
 * | `PUT /g/{group}/settings` | 200 `{ fields, marketplace, created }`; with `create`, makes the store if there is none, and without it 404 `no_store` |
 * | `PUT /g/{group}/projection/{table}` | 200; 404 `no_store`; 409 `stale_projection` or `settings_mismatch`; 413 `projection_limit`; 400 `bad_projection` |
 * | `DELETE /g/{group}` | 204, whether or not there was a store |
 *
 * **Every route is behind the door, and there is no other.** No public route, no route for an
 * integration yet (that is the issue's PR 3, with tokens this Worker mints and never a relay
 * token). The order of the checks is the share Worker's: the path, then the method (405 before
 * 401 — a fact about the request that costs nothing, where an HMAC verify does not), then the
 * KEK, then the gate, then whatever the route costs.
 */

/**
 * The group segment — the share Worker's `GROUP_SEGMENT`, spelled from the relay's character
 * class rather than imported from `claim.ts`, for that Worker's reason: an unconstrained segment
 * lets `%41` and `A` name two groups a reader would read as one.
 */
const GROUP_SEGMENT = "[A-Za-z0-9_-]{1,128}";

/** The four shapes, each with the one method it takes. A `table` outside the six is no route. */
const DIGESTS = new RegExp(`^/g/(${GROUP_SEGMENT})/projection/digests$`);
const SETTINGS = new RegExp(`^/g/(${GROUP_SEGMENT})/settings$`);
const PROJECTION = new RegExp(`^/g/(${GROUP_SEGMENT})/projection/(${TABLES.join("|")})$`);
const GROUP = new RegExp(`^/g/(${GROUP_SEGMENT})$`);

type Route =
  | { kind: "digests"; group: string; method: "GET" }
  | { kind: "settings"; group: string; method: "PUT" }
  | { kind: "projection"; group: string; table: Table; method: "PUT" }
  | { kind: "delete"; group: string; method: "DELETE" };

function match(path: string): Route | null {
  let found: RegExpExecArray | null;
  if ((found = DIGESTS.exec(path)) !== null) {
    return { kind: "digests", group: found[1], method: "GET" };
  }
  if ((found = SETTINGS.exec(path)) !== null) {
    return { kind: "settings", group: found[1], method: "PUT" };
  }
  if ((found = PROJECTION.exec(path)) !== null && isTable(found[2])) {
    return { kind: "projection", group: found[1], table: found[2], method: "PUT" };
  }
  if ((found = GROUP.exec(path)) !== null) {
    return { kind: "delete", group: found[1], method: "DELETE" };
  }
  return null;
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

async function route(request: Request, env: Env, found: Route): Promise<Response> {
  if (request.method !== found.method) {
    return new Response(
      JSON.stringify({ error: "method not allowed", code: "method_not_allowed" }),
      { status: 405, headers: { "content-type": "application/json", allow: found.method } },
    );
  }
  // **The KEK before the gate**, so a deploy without it is a 500 naming it to a request with no
  // token at all — the tell the relay's signing key gives through the gate to a request with a
  // bad one, and what the README's check and the release's probe read. Imported and dropped: the object imports its
  // own, and this costs one key import on a request that is about to verify an HMAC anyway.
  await importKek(env.INTEGRATIONS_KEK, "INTEGRATIONS_KEK");
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
  }
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
      preflight(request, origin, found.method) ?? withCors(await route(request, env, found), origin)
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
