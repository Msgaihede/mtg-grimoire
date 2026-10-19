import { vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { sha256Hex, type Env } from "./env";
import type {
  BotDeviceRpc,
  BotNamespace,
  BotStatus,
  Enrolled,
  EnrollRefused,
  InteractionAnswer,
  InteractionRequest,
} from "./rpc";
import type { Card } from "./scryfall";

/**
 * The suite's stand-ins: D1, the bot's Durable Objects, the limiter, Discord's signing key, and
 * Scryfall and Discord's OAuth endpoints behind one `fetch`.
 *
 * There is no workerd here, by `vitest.config.ts`'s deliberate choice, so the handler is a plain
 * function over an injected `Env`. **D1 is a real SQLite** — Node's `node:sqlite`, in memory —
 * built from this folder's own `migrations/`, so a statement the Worker sends is run against the
 * schema a deploy applies: a column misspelled on either side, a `CHECK` a row breaks, a second
 * link for one account or two links sharing a secret are each a failure here and not a fake's
 * shrug. **The bot namespace records every call and answers what a test tells it to**, because
 * half of what this Worker promises is an absence — a refused request reached no Durable Object
 * — and an absence can only be asserted against something that would have recorded it.
 */

const MIGRATIONS = import.meta.glob("/infrastructure/discord-worker/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** A Discord user id, and a second one: the reader and somebody else in the same channel. */
export const READER = "200000000000000001";
export const STRANGER = "200000000000000002";
export const APPLICATION_ID = "100000000000000001";

type Value = string | number | null;

/** D1's statement API over one SQLite database: `bind`, `first`, `all`, `run` and `batch`. */
function d1Over(db: DatabaseSync): D1Database {
  const statement = (sql: string, params: Value[]) => ({
    bind: (...values: Value[]) => statement(sql, values),
    first: <T>() => Promise.resolve((db.prepare(sql).get(...params) ?? null) as T | null),
    all: <T>() =>
      Promise.resolve({
        success: true,
        meta: {},
        results: db
          .prepare(sql)
          .all(...params)
          .map((row) => ({ ...row })) as T[],
      }),
    run: () => {
      const { changes } = db.prepare(sql).run(...params);
      return Promise.resolve({ success: true, meta: { changes: Number(changes) } });
    },
  });
  return {
    prepare: (sql: string) => statement(sql, []),
    // D1 runs a batch as one transaction; so does this.
    batch: async (statements: { run: () => Promise<unknown> }[]) => {
      db.exec("BEGIN");
      try {
        const out = [];
        for (const one of statements) out.push(await one.run());
        db.exec("COMMIT");
        return out;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
}

/** A fresh database with this Worker's migrations applied, in name order. */
export function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const name of Object.keys(MIGRATIONS).sort()) db.exec(MIGRATIONS[name]);
  return db;
}

// ---------------------------------------------------------------------------------------
// The bot's Durable Objects
// ---------------------------------------------------------------------------------------

export interface BotCall {
  /** The Durable Object's id, as `toString()` spells it. */
  id: string;
  method: keyof BotDeviceRpc;
  arg?: unknown;
}

/** What each method answers; a function is called with the argument, and may throw. */
export interface BotAnswers {
  enroll: Enrolled | EnrollRefused;
  interaction: InteractionAnswer | ((req: InteractionRequest) => InteractionAnswer);
  status: BotStatus;
}

export interface FakeBots {
  namespace: BotNamespace;
  calls: BotCall[];
  /** Every id `newUniqueId` minted, in order. */
  minted: string[];
  answers: BotAnswers;
  /** When true, every call on every stub throws, as a script that is not deployed does. */
  down: boolean;
}

const fakeId = (hex: string): DurableObjectId => ({
  toString: () => hex,
  equals: (other: DurableObjectId) => other.toString() === hex,
});

/** A namespace whose ids are 64 hex characters, as a real one's are. */
export function bots(): FakeBots {
  const fake: FakeBots = {
    calls: [],
    minted: [],
    down: false,
    answers: {
      enroll: {
        ok: true,
        deviceId: "the-bots-device-id",
        x25519: "x".repeat(43),
        ed25519: "e".repeat(43),
      },
      interaction: {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ type: 5, data: { flags: 64 } }),
      },
      status: {
        enrolled: true,
        deviceId: "the-bots-device-id",
        paired: true,
        lastPullAt: 1_760_700_000_000,
        error: null,
      },
    },
    namespace: {
      newUniqueId() {
        const hex = [...crypto.getRandomValues(new Uint8Array(32))]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
        fake.minted.push(hex);
        return fakeId(hex);
      },
      idFromString: (hex: string) => fakeId(hex),
      get(id: DurableObjectId): BotDeviceRpc {
        const call = <T>(method: keyof BotDeviceRpc, arg: unknown, answer: () => T) => {
          fake.calls.push(
            arg === undefined ? { id: id.toString(), method } : { id: id.toString(), method, arg },
          );
          if (fake.down) return Promise.reject(new Error("the bot device is not deployed"));
          return Promise.resolve().then(answer);
        };
        return {
          enroll: (req) => call("enroll", req, () => fake.answers.enroll),
          interaction: (req) =>
            call("interaction", req, () => {
              const answer = fake.answers.interaction;
              return typeof answer === "function" ? answer(req) : answer;
            }),
          status: () => call("status", undefined, () => fake.answers.status),
          unlink: () => call("unlink", undefined, () => undefined),
        };
      },
    },
  };
  return fake;
}

// ---------------------------------------------------------------------------------------
// The Worker's bindings
// ---------------------------------------------------------------------------------------

export interface Harness {
  env: Env;
  db: DatabaseSync;
  bots: FakeBots;
  /** Every key the limiter was asked about, in order. */
  limited: string[];
  /** A table's rows, oldest first, as plain objects. */
  rows(table: string): Record<string, unknown>[];
}

export const PLACEHOLDER = "<set when the Discord application exists>";

/**
 * The Worker's bindings over an empty database. `allow` is what the limiter answers;
 * `secret: null` leaves `DISCORD_CLIENT_SECRET` unset, as a Worker deployed before its secret
 * is; `placeholders` leaves the application's id and key as `wrangler.jsonc` ships them.
 */
export function harness(
  options: {
    publicKey?: string;
    allow?: boolean;
    secret?: string | null;
    placeholders?: boolean;
  } = {},
): Harness {
  const db = database();
  const fake = bots();
  const limited: string[] = [];
  const env: Env = {
    DB: d1Over(db),
    BOT: fake.namespace,
    RL_BEGIN: {
      limit({ key }: { key: string }) {
        limited.push(key);
        return Promise.resolve({ success: options.allow ?? true });
      },
    },
    DISCORD_BASE: "https://discord.mtg-grimoire.app",
    DISCORD_APPLICATION_ID: options.placeholders === true ? PLACEHOLDER : APPLICATION_ID,
    // A well-formed key nobody holds the private half of, unless the test signs with its own.
    DISCORD_PUBLIC_KEY:
      options.placeholders === true ? PLACEHOLDER : (options.publicKey ?? "ab".repeat(32)),
  };
  if (options.secret !== null) env.DISCORD_CLIENT_SECRET = options.secret ?? "a-test-client-secret";
  return {
    env,
    db,
    bots: fake,
    limited,
    rows: (table) =>
      db
        .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
        .all()
        .map((row) => ({ ...row })),
  };
}

/** A database that throws when it is touched: a request that should be refused first must not reach it. */
export const untouchable = new Proxy(
  {},
  {
    get() {
      throw new Error("the database was reached by a request that should have been refused");
    },
  },
) as D1Database;

// ---------------------------------------------------------------------------------------
// Discord's signature, and the interactions it signs
// ---------------------------------------------------------------------------------------

const hex = (bytes: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

export interface Signer {
  publicKeyHex: string;
  sign(timestamp: string, body: string): Promise<string>;
  /** The same over a body's raw bytes, for a body that is not text. */
  signBytes(timestamp: string, body: Uint8Array): Promise<string>;
}

/** An Ed25519 key of the suite's own, standing in for the Discord application's. */
export async function signer(): Promise<Signer> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer;
  const signBytes = async (timestamp: string, body: Uint8Array) => {
    const stamp = new TextEncoder().encode(timestamp);
    const message = new Uint8Array(stamp.byteLength + body.byteLength);
    message.set(stamp, 0);
    message.set(body, stamp.byteLength);
    return hex(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, message));
  };
  return {
    publicKeyHex: hex(raw),
    sign: (timestamp, body) => signBytes(timestamp, new TextEncoder().encode(body)),
    signBytes,
  };
}

/** The reader's identity as Discord puts it in an interaction: `user` in a DM. */
export const asUser = (id = READER) => ({ user: { id, username: "reader" } });
/** And as it puts it in a server: `member.user`. */
export const asMember = (id = READER) => ({ member: { user: { id, username: "reader" } } });

/** An interaction, signed by `by`, as Discord posts one. `text` is the body exactly. */
export async function signedRequest(
  by: Signer,
  text: string,
  options: { timestamp?: string; signature?: string | null } = {},
): Promise<Request> {
  const timestamp = options.timestamp ?? "1760700000";
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-signature-timestamp": timestamp,
  };
  const signature =
    options.signature === undefined ? await by.sign(timestamp, text) : options.signature;
  if (signature !== null) headers["x-signature-ed25519"] = signature;
  return new Request("https://discord.mtg-grimoire.app/interactions", {
    method: "POST",
    headers,
    body: text,
  });
}

/** {@link signedRequest} of a value. */
export const interaction = (
  by: Signer,
  body: unknown,
  options: { timestamp?: string; signature?: string | null } = {},
) => signedRequest(by, JSON.stringify(body), options);

/** A slash command (type 2) or an autocomplete (type 4): `name`, optionally a subcommand, and its options. */
export function slash(
  name: string,
  sub: string | null,
  options: { name: string; type?: number; value: unknown; focused?: boolean }[],
  who: object = asUser(),
  type = 2,
): unknown {
  const leaves = options.map(({ type: kind, ...rest }) => ({ type: kind ?? 3, ...rest }));
  return {
    type,
    id: "300000000000000001",
    application_id: APPLICATION_ID,
    token: "an-interaction-token",
    data: {
      name,
      type: 1,
      options: sub === null ? leaves : [{ type: 1, name: sub, options: leaves }],
    },
    ...who,
  };
}

// ---------------------------------------------------------------------------------------
// Scryfall and Discord's OAuth, behind one `fetch`
// ---------------------------------------------------------------------------------------

export const SOL_RING: Card = {
  id: "b8a68840-4044-4b9c-8fa8-5e7a9d3d6fa4",
  name: "Sol Ring",
  set: "c21",
  set_name: "Commander 2021",
  collector_number: "263",
  scryfall_uri: "https://scryfall.com/card/c21/263/sol-ring",
  mana_cost: "{1}",
  type_line: "Artifact",
  oracle_text: "{T}: Add {C}{C}.",
  image_uris: { normal: "https://cards.scryfall.io/normal/front/b/8/b8a68840.jpg" },
  prices: { usd: "1.50", usd_foil: "4.00", usd_etched: null },
};

export const DELVER: Card = {
  id: "11bf83bb-c95b-4b4f-9a56-ce7a1816307a",
  name: "Delver of Secrets // Insectile Aberration",
  set: "isd",
  set_name: "Innistrad",
  collector_number: "51",
  scryfall_uri: "https://scryfall.com/card/isd/51/delver-of-secrets-insectile-aberration",
  card_faces: [
    {
      name: "Delver of Secrets",
      mana_cost: "{U}",
      type_line: "Creature — Human Wizard",
      oracle_text: "At the beginning of your upkeep, look at the top card of your library.",
      power: "1",
      toughness: "1",
      image_uris: { normal: "https://cards.scryfall.io/normal/front/1/1/11bf83bb.jpg" },
    },
    {
      name: "Insectile Aberration",
      mana_cost: "",
      type_line: "Creature — Human Insect",
      oracle_text: "Flying",
      power: "3",
      toughness: "2",
      image_uris: { normal: "https://cards.scryfall.io/normal/back/1/1/11bf83bb.jpg" },
    },
  ],
  prices: { usd: "0.25", usd_foil: "2.00" },
};

export interface Asked {
  url: URL;
  method: string;
  headers: Headers;
  body: string;
}

/**
 * A stand-in for the internet: Scryfall's three endpoints over `cards`, and Discord's two OAuth
 * endpoints, which answer `user` for the code `"good-code"` and refuse any other. `down` makes
 * every request fail as an unreachable host does; `status` makes Scryfall answer that status.
 * Every request is recorded.
 */
export function internet(
  options: {
    cards?: Card[];
    down?: boolean;
    status?: number;
    user?: { id: string; username: string };
  } = {},
): Asked[] {
  const cards = options.cards ?? [SOL_RING, DELVER];
  const asked: Asked[] = [];
  const answer = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const body = typeof init.body === "string" ? init.body : "";
    asked.push({ url, method: init.method ?? "GET", headers: new Headers(init.headers), body });
    if (options.down === true) return Promise.reject(new TypeError("fetch failed"));

    if (url.host === "api.scryfall.com") {
      if (options.status !== undefined)
        return Promise.resolve(answer({ object: "error" }, options.status));
      if (url.pathname === "/cards/autocomplete") {
        const q = (url.searchParams.get("q") ?? "").toLowerCase();
        const data = cards
          .map((card) => card.name)
          .filter((name) => name.toLowerCase().includes(q));
        return Promise.resolve(answer({ object: "catalog", data }));
      }
      if (url.pathname === "/cards/search") {
        // Only the query `printings` sends: `!"<name>" unique:prints`.
        const q = url.searchParams.get("q") ?? "";
        const exact = /^!"(.*)" unique:prints$/.exec(q)?.[1]?.toLowerCase();
        const data = cards.filter((card) => card.name.toLowerCase() === exact);
        return Promise.resolve(
          data.length === 0
            ? answer({ object: "error", status: 404, code: "not_found" }, 404)
            : answer({
                object: "list",
                has_more: false,
                data: data.map((card) => ({ object: "card", ...card })),
              }),
        );
      }
      if (url.pathname === "/cards/named") {
        const wanted = (url.searchParams.get("fuzzy") ?? "").toLowerCase().replace(/[^a-z]/g, "");
        const found = cards.find((card) =>
          card.name
            .toLowerCase()
            .replace(/[^a-z]/g, "")
            .startsWith(wanted),
        );
        return Promise.resolve(
          found === undefined
            ? answer({ object: "error", status: 404, code: "not_found" }, 404)
            : answer({ object: "card", ...found }),
        );
      }
    }
    if (url.host === "discord.com" && url.pathname === "/api/v10/oauth2/token") {
      const form = new URLSearchParams(body);
      return Promise.resolve(
        form.get("code") === "good-code"
          ? answer({ access_token: "a-discord-access-token", token_type: "Bearer" })
          : answer({ error: "invalid_grant" }, 400),
      );
    }
    if (url.host === "discord.com" && url.pathname === "/api/v10/users/@me") {
      const user = options.user ?? { id: READER, username: "reader" };
      return Promise.resolve(
        new Headers(init.headers).get("authorization") === "Bearer a-discord-access-token"
          ? answer({ ...user, global_name: "Reader" })
          : answer({ message: "401: Unauthorized" }, 401),
      );
    }
    return Promise.resolve(answer({ error: "nothing here" }, 404));
  });
  return asked;
}

// ---------------------------------------------------------------------------------------
// The desktop's requests
// ---------------------------------------------------------------------------------------

/** A request from the desktop, with `secret` as its bearer when given. */
export function desktop(
  method: string,
  path: string,
  options: { secret?: string; body?: BodyInit | null; headers?: Record<string, string> } = {},
): Request {
  const headers: Record<string, string> = { "cf-connecting-ip": "203.0.113.9", ...options.headers };
  if (options.secret !== undefined) headers.authorization = `Bearer ${options.secret}`;
  return new Request(`https://discord.mtg-grimoire.app${path}`, {
    method,
    headers,
    body: options.body ?? null,
  });
}

/** A JSON body for {@link desktop}. */
export const jsonOf = (value: unknown) => ({
  body: JSON.stringify(value),
  headers: { "content-type": "application/json" },
});

/** The suite's link secret: 43 base64url characters, as the Worker mints one. Not a secret. */
export const SECRET = "a-test-link-secret-of-forty-three-character";

/** A Durable Object id, as a real one spells itself. */
export const DO_ID = "d0".repeat(32);

/** A reader already linked, as a claim leaves one — `secret` hashed into `discord_links`. */
export async function linked(
  h: Harness,
  options: { user?: string; username?: string; secret?: string; doId?: string } = {},
): Promise<void> {
  h.db
    .prepare(
      `INSERT INTO discord_links (discord_user_id, username, secret_hash, do_id, created_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      options.user ?? READER,
      options.username ?? "reader",
      await sha256Hex(options.secret ?? SECRET),
      options.doId ?? DO_ID,
      1_760_000_000_000,
    );
}
