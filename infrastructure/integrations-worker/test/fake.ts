/**
 * The suite's stand-ins, and nothing the Worker deploys imports: a Durable Object's SQL storage
 * and the relay's D1, both over a real SQLite in memory (Node's `node:sqlite`), a namespace that
 * hands out a `Store` per group the way `idFromName` hands out an object, an `Env`, and tokens
 * minted with the relay's own `mint`.
 *
 * **Real SQLite and not `@grimoire/relay/src/fakeD1`**, for both halves. The object's storage is
 * SQL the fake evaluator does not speak (`sqlite_master`, `WITHOUT ROWID`, `ON CONFLICT … DO
 * UPDATE SET … excluded`), and the D1 half is the relay's own `schema.sql` with this Worker's
 * migrations applied over it — so the lapse pass's `NOT IN` meets SQLite's NULL rule, not a
 * model of it, and the migration a release applies is the one the suite ran.
 * (`fakeD1.ts` ruled `node:sqlite` out when CI's Node 22 kept it behind a flag; the engines
 * field is `>=22.18` now, where it is not, and `scripts/d1-migrations.test.ts` opens it too.)
 *
 * **What it does not model** is Workers RPC's structured clone — an argument reaches the `Store`
 * by reference — and workerd's input gates. The store decides everything again inside its last
 * transaction for that reason (`store.ts`), and `store.test.ts` interleaves two replacements to
 * hold it to that.
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mint, TOKEN_TTL_MS } from "@grimoire/relay/src/token";
import relaySchema from "../../relay/schema.sql?raw";
import worker, { type Env } from "../src/worker";
import { FIELD_NAMES, type IntegrationFields } from "../src/projection";
import { toBase64url } from "../src/seal";
import { Store, type KekEnv, type SqlStorageLike } from "../src/store";

const OWN_MIGRATIONS = import.meta.glob("/infrastructure/integrations-worker/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** The suite's relay signing key. Not a secret of anybody's: no deploy holds it. */
export const KEY = "test-signing-key";
/** A KEK for the suite: 32 bytes of base64url, which is the shape the Worker insists on. */
export const KEK = toBase64url(new Uint8Array(32).fill(7));
/** A second, for a rotation. */
export const NEXT_KEK = toBase64url(new Uint8Array(32).fill(9));
/** The one origin `wrangler.jsonc` lets a page ask from. */
export const APP = "https://mtg-grimoire.app";
/** Where the suite's requests go: the provisional address, which nothing here depends on. */
export const BASE = "https://integrations.example";

/** Every field on, and every field off — the two policies most cases need. */
export const ALL_ON = Object.fromEntries(
  FIELD_NAMES.map((name) => [name, true]),
) as IntegrationFields;
export const ALL_OFF = Object.fromEntries(
  FIELD_NAMES.map((name) => [name, false]),
) as IntegrationFields;

/**
 * A Durable Object's SQL storage — `sql.exec`, `transactionSync` and `deleteAll` — in memory.
 *
 * **It counts rows written, by table**, the way the platform bills them: every row an `INSERT`,
 * `UPDATE` or `DELETE` changed (a delete is a write), and nothing a rolled-back transaction did.
 * The only index on `rows` is its primary key, the table itself (`WITHOUT ROWID`), so no index
 * row goes uncounted.
 */
export function sqlStorage(): SqlStorageLike & {
  readonly db: DatabaseSync;
  readonly written: Record<string, number>;
} {
  let db = new DatabaseSync(":memory:");
  const written: Record<string, number> = {};
  const count = (query: string, changes: number) => {
    const target = /^\s*(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|DELETE\s+FROM|UPDATE)\s+(\w+)/i.exec(
      query,
    )?.[1];
    if (target !== undefined && changes > 0) written[target] = (written[target] ?? 0) + changes;
  };
  // workerd keeps a statement it has prepared; so does this, or a 50,000-row insert would be
  // measured preparing the same text 50,000 times.
  let prepared = new Map<string, StatementSync>();
  const statement = (query: string) => {
    let found = prepared.get(query);
    if (found === undefined) {
      found = db.prepare(query);
      prepared.set(query, found);
    }
    return found;
  };
  return {
    get db() {
      return db;
    },
    written,
    sql: {
      exec(query: string, ...bindings: unknown[]) {
        // An `ArrayBuffer` by its tag and not `instanceof`: WebCrypto's come from another realm
        // under the suite's jsdom, and `instanceof` says no to them.
        const params = bindings.map((b) =>
          Object.prototype.toString.call(b) === "[object ArrayBuffer]"
            ? new Uint8Array(b as ArrayBuffer)
            : b,
        ) as (string | number | null | Uint8Array)[];
        const run = statement(query);
        if (/^\s*select/i.test(query)) {
          const rows = run.all(...params);
          return { toArray: () => rows as Record<string, unknown>[] };
        }
        count(query, Number(run.run(...params).changes));
        return { toArray: () => [] };
      },
    },
    transactionSync<T>(closure: () => T): T {
      const before = { ...written };
      db.exec("BEGIN");
      try {
        const out = closure();
        db.exec("COMMIT");
        return out;
      } catch (error) {
        db.exec("ROLLBACK");
        for (const key of Object.keys(written)) delete written[key];
        Object.assign(written, before);
        throw error;
      }
    },
    // workerd's `deleteAll` on a SQLite-backed object takes the whole database, tables and all.
    async deleteAll() {
      db.close();
      db = new DatabaseSync(":memory:");
      prepared = new Map();
    },
  };
}

/** The relay's D1, as a `D1Database` over node:sqlite: `prepare`/`bind`/`first`/`all`/`run`/`batch`. */
function d1Of(db: DatabaseSync): D1Database {
  type Value = string | number | null;
  const statement = (sql: string, params: Value[]) => ({
    bind: (...values: Value[]) => statement(sql, values),
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ success: true, meta: {}, results: db.prepare(sql).all(...params) }),
    run: async () => {
      const result = db.prepare(sql).run(...params);
      return { success: true, meta: { changes: Number(result.changes) }, results: [] };
    },
  });
  return {
    prepare: (sql: string) => statement(sql, []),
    batch: async (statements: { run: () => Promise<unknown> }[]) => {
      db.exec("BEGIN");
      try {
        const results = [];
        for (const one of statements) results.push(await one.run());
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
}

/** The relay's database as production holds it: its baseline, then this Worker's migrations. */
export function relayDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(relaySchema);
  const files = Object.entries(OWN_MIGRATIONS).sort(([a], [b]) => (a < b ? -1 : 1));
  for (const [, text] of files) db.exec(text);
  return db;
}

/** An entitlement row as the relay's `reconcile` leaves it. */
export function entitle(
  db: DatabaseSync,
  subject: string,
  group: string | null,
  status = "active",
  graceUntil: number | null = null,
): void {
  db.prepare(
    `INSERT INTO entitlements (subject, source, external_id, status, grace_until, group_id,
       refresh_secret, patreon_refresh, created_at, checked_at)
     VALUES (?, 'patreon', ?, ?, ?, ?, NULL, NULL, 0, 0)`,
  ).run(subject, subject, status, graceUntil, group);
}

/** One object per group name, as `idFromName` gives one — made on first `get`, kept after. */
export function namespace(env: KekEnv) {
  const objects = new Map<string, { store: Store; storage: ReturnType<typeof sqlStorage> }>();
  /** Groups whose object throws on every call: a Durable Object that is down. */
  const failing = new Set<string>();
  const objectOf = (name: string) => {
    let found = objects.get(name);
    if (found === undefined) {
      const storage = sqlStorage();
      found = { storage, store: new Store(storage, env) };
      objects.set(name, found);
    }
    return found;
  };
  const down = new Proxy(
    {},
    {
      get: () => () => Promise.reject(new Error("the object is down")),
    },
  );
  const binding = {
    idFromName: (name: string) => ({ name, toString: () => name }),
    get: (id: { name: string }) => (failing.has(id.name) ? down : objectOf(id.name).store),
  };
  return { binding, objects, failing, objectOf };
}

/**
 * The Worker over all of the above, with `g1` entitled. `env` is the object every store reads its
 * secrets from, so a case can move the KEK under them.
 */
export function harness() {
  const db = relayDatabase();
  entitle(db, "sub-1", "g1");
  const env = {
    DB: d1Of(db),
    RELAY_HMAC_KEY: KEY,
    INTEGRATIONS_KEK: KEK,
    APP_ORIGINS: APP,
  } as Env;
  const stores = namespace(env);
  env.STORE = stores.binding as unknown as DurableObjectNamespace;
  return {
    env,
    db,
    stores,
    fetch: (request: Request) => worker.fetch(request, env),
  };
}

/**
 * A token good for the next minute — `Date.now()` and never a fixture stamp, for the share
 * Worker's reason: the gate verifies against the real clock.
 */
export async function token(
  group = "g1",
  claims: { exp?: number; dev?: string; ep?: number } = {},
): Promise<string> {
  return mint({ sub: "sub-1", grp: group, exp: Date.now() + 60_000, ...claims }, KEY);
}

/** A token minted `at`, as the relay would have: `exp` one TTL past its clock. */
export async function mintedAt(at: number, dev?: string): Promise<string> {
  const claims = { sub: "sub-1", grp: "g1", exp: at + TOKEN_TTL_MS };
  return mint(dev === undefined ? claims : { ...claims, dev }, KEY);
}

/** `body` gzipped, as the publisher sends a projection. */
export async function gzip(body: string | Uint8Array): Promise<Uint8Array> {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  }).pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A digest-shaped string: what the store keeps is whatever the device said, so any will do. */
export const digestOf = (n: number) => n.toString(16).padStart(64, "0");

/** The requests the router takes, each with a bearer unless `bearer` is `null`. */
export function request(
  method: string,
  path: string,
  init: { bearer?: string | null; headers?: Record<string, string>; body?: BodyInit } = {},
): Request {
  const headers: Record<string, string> = { ...init.headers };
  if (init.bearer !== undefined && init.bearer !== null) {
    headers.authorization = `Bearer ${init.bearer}`;
  }
  return new Request(`${BASE}${path}`, { method, headers, body: init.body });
}

/** `PUT /g/{group}/settings` with this policy — on TCGplayer, and allowed to make the store, unless told otherwise. */
export async function putSettings(
  fetch: (r: Request) => Promise<Response>,
  fields: IntegrationFields,
  group = "g1",
  { marketplace = "tcgplayer", create = true }: { marketplace?: string; create?: boolean } = {},
): Promise<Response> {
  return fetch(
    request("PUT", `/g/${group}/settings`, {
      bearer: await token(group),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fields, marketplace, create }),
    }),
  );
}

/** `PUT /g/{group}/projection/{table}` with a document, gzipped, at a watermark. */
export async function putTable(
  fetch: (r: Request) => Promise<Response>,
  table: string,
  document: unknown,
  options: { ms?: number; ctr?: number; digest?: string; group?: string; raw?: Uint8Array } = {},
): Promise<Response> {
  const group = options.group ?? "g1";
  const body = options.raw ?? (await gzip(JSON.stringify(document)));
  return fetch(
    request("PUT", `/g/${group}/projection/${table}`, {
      bearer: await token(group),
      headers: {
        "content-type": "application/gzip",
        "x-projection-hlc-ms": String(options.ms ?? 1_000),
        "x-projection-hlc-ctr": String(options.ctr ?? 0),
        "x-projection-digest": options.digest ?? digestOf(1),
      },
      body,
    }),
  );
}

/** A `Projection v1` document of `table` under `fields`, priced from `marketplace` in its currency, with these rows. */
export function documentOf(
  table: string,
  rows: object[],
  fields: string[] = [],
  marketplace = "tcgplayer",
) {
  const currency = marketplace === "cardmarket" ? "EUR" : "USD";
  return { v: 1, table, fields, marketplace, currency, rows };
}

/** Every scope — what most consumer cases mint. */
export const ALL_SCOPES = [
  "collection:read",
  "wishlist:read",
  "decks:read",
  "collection:add",
  "wishlist:add",
];

/** `POST /g/{group}/consumers/{integration}` from a device: the token, or the answer that refused it. */
export async function mintConsumer(
  fetch: (r: Request) => Promise<Response>,
  integration = "discord",
  scopes: string[] = ALL_SCOPES,
  { days = 30, group = "g1" }: { days?: number; group?: string } = {},
): Promise<Response> {
  return fetch(
    request("POST", `/g/${group}/consumers/${integration}`, {
      bearer: await token(group),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scopes, days }),
    }),
  );
}

/** {@link mintConsumer}'s token, for a case that only needs one that works. */
export async function consumerToken(
  fetch: (r: Request) => Promise<Response>,
  integration = "discord",
  scopes: string[] = ALL_SCOPES,
  options: { days?: number; group?: string } = {},
): Promise<string> {
  const res = await mintConsumer(fetch, integration, scopes, options);
  if (res.status !== 200) throw new Error(`minting answered ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { token: string }).token;
}

/** A consumer route, with the token as its bearer and `body` as JSON. */
export function consumerRequest(
  method: string,
  path: string,
  bearer: string | null,
  body?: unknown,
): Request {
  return request(method, path, {
    bearer,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** A collection add as plan §3.1 spells one, with its hints. */
export function collectionAdd(overrides: Record<string, unknown> = {}) {
  return {
    kind: "collection.add",
    payload: {
      scryfallId: "0000579f-7b35-4ed3-b44c-db2a538066fe",
      finish: "nonfoil",
      quantity: 2,
      folderUid: "fold-binder",
      name: "Lightning Bolt",
      set: "2x2",
      cn: "117",
      ...overrides,
    },
    confirmedBy: "discord:123",
  };
}

/** A wishlist add — an any-printing wish at the root. */
export function wishlistAdd(overrides: Record<string, unknown> = {}) {
  return {
    kind: "wishlist.add",
    payload: {
      scryfallId: null,
      oracleId: "4457ed35-7c10-48c8-9776-456485fdf070",
      finish: null,
      quantity: 1,
      folderUid: null,
      name: "Counterspell",
      ...overrides,
    },
    confirmedBy: null,
  };
}

/** `POST /c/intents`. */
export function postIntent(
  fetch: (r: Request) => Promise<Response>,
  bearer: string,
  body: unknown,
): Promise<Response> {
  return fetch(consumerRequest("POST", "/c/intents", bearer, body));
}

/** A device's request on an inbox route, with the relay token and `body` as JSON. */
export async function deviceRequest(
  method: string,
  path: string,
  body?: unknown,
  group = "g1",
): Promise<Request> {
  return request(method, path, {
    bearer: await token(group),
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
