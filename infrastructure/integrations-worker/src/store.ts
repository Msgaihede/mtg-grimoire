import { inflate, MAX_INFLATED_BYTES } from "./body";
import { signToken, verifyToken, type Claims } from "./consumer";
import {
  ALREADY_ACKED,
  CLAIMED,
  hintName,
  INTENT_QUOTA,
  INTENTS_PER_DAY,
  KEEP_ACKED_MS,
  LEASE_MS,
  MAX_PENDING_LISTED,
  NO_DECK,
  NO_INTENT,
  overlayRow,
  parseIntentShape,
  randomId,
  SCOPE,
  scopeFor,
  scopesOf,
  utcDay,
  validatePayload,
  BAD_INTENT,
  type Ack,
  type Integration,
  type Intent,
  type Kind,
  type Scope,
  type Source,
  type State,
} from "./intents";
import {
  clearColumns,
  enabledNames,
  isMarketplace,
  normaliseName,
  parseFields,
  validateDocument,
  type Document,
  type FieldName,
  type GroupSettings,
  type IntegrationFields,
  type Table,
} from "./projection";
import {
  consumerKey,
  importKek,
  intentKey,
  kekFingerprint,
  macKey,
  newDataKey,
  openIntent,
  openRow,
  rewrap,
  rowKey,
  rowMac,
  sealIntent,
  sealRow,
  toBase64url,
  unwrapDataKey,
  wrapDataKey,
} from "./seal";

/**
 * **One group's store**: the projection a group's devices publish, in the group's own Durable
 * Object (`object.ts` binds this to workerd; the suite drives it over `node:sqlite`).
 *
 * ```sql
 * meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)
 *   -- group, store_id, data_key (wrapped), kek (its fingerprint), fields (JSON), marketplace,
 *   -- created_at, generation
 * tables(tbl TEXT PRIMARY KEY, digest TEXT, hlc_ms INTEGER, hlc_ctr INTEGER, generation INTEGER,
 *        rows INTEGER, published_at INTEGER)
 * rows(tbl, uid, scryfall_id, name_norm, set_code, cn, finish, quantity, folder_uid, kind,
 *      gen INTEGER, mac BLOB, sealed BLOB, PRIMARY KEY (tbl, uid))
 * intents(id PRIMARY KEY, source, kind, state, created_at, acked_at, lease, lease_until,
 *         ack_hlc_ms, ack_hlc_ctr, reason, name_norm, folder_uid, sealed BLOB)
 * consumers(integration PRIMARY KEY, tid, scopes (JSON), issued_at, exp)
 * intent_days(integration, day, count, PRIMARY KEY (integration, day))
 * ```
 *
 * **The inbox** (the PR 3 plan, `2026-10-29-integrations-intents.md`): intents an integration
 * writes through a consumer token, a device of the group claims, applies as its own write and
 * acks. Sealed like the rows — `{ payload, confirmedBy }` under a key of the inbox's own — beside
 * the clear columns the overlay and the caps query. **The consumer tokens' rows** are what a
 * revoke deletes and a re-mint replaces; the tokens' key is drawn from the data key, so
 * `deleteAll` revokes every one of them by taking it.
 *
 * **The store's existence is the group's switch** (plan §2). `settings` makes one — a data key,
 * the policy, the three tables — and nothing else does: a projection `PUT` or a digests `GET` on
 * an object with no store answers `no_store` and writes nothing, so a device that has not heard
 * of a switch-off cannot bring back what was deleted. `deleteAll` empties the object.
 *
 * **A device sends a table whole; the store writes only what changed** (the spec's §6.1: move
 * off whole-table replacement once a measurement shows it hurts — a whole-table replace wrote
 * ~2N rows a publish, the free plan's day for a 50,000-card collection in one). Every row keeps a
 * keyed MAC of its canonical JSON (`seal.ts`'s `rowMac`), so a replacement deletes the rows
 * whose `uid` is gone, seals and upserts the rows that are new or whose MAC moved, and leaves
 * every other row as it was — not opened, not sealed again, not written. A row keeps the
 * generation it was sealed in (`gen`), so rows of many generations open side by side. A change of
 * policy still drops every table, so the next publish seals everything afresh.
 *
 * **One `transactionSync` writes a replacement**, so a reader sees the old table or the new one.
 * The MACs and the sealing before it are async (WebCrypto), and another request to this object
 * can run while they await — so the transaction decides everything again: the store still
 * exists and is the same store (its `store_id`, not one switched off and on again under a new
 * data key), its policy is still the document's, no newer watermark landed, and every row it would
 * leave or write is one it holds a MAC — and, where it changed, a sealed body — for. A row another
 * publish changed in the meantime is sealed and the transaction asked again.
 *
 * **Only the index columns are in the clear** (`projection.ts`'s `clearColumns`), with the
 * row's generation and its MAC; every row whole is `sealed` (`seal.ts`). **There is no index
 * beyond the primary key, deliberately**, now that the consumer routes query these columns too: a
 * Durable Object's SQLite bills each row written, an index's row included, and a consumer's search
 * is a substring of a name (`LIKE '%q%'`), which no B-tree serves — a scan of one table's clear
 * columns, measured in `test/measure.test.ts` at 50,000 rows. Only the rows a read answers with
 * are opened.
 */

/** The part of `ctx.storage` a store uses — `DurableObjectStorage`'s, narrowed for the suite. */
export interface SqlStorageLike {
  sql: { exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] } };
  transactionSync<T>(closure: () => T): T;
  deleteAll(): Promise<void>;
}

/** The two secrets a store reads: the KEK, and the one before it while a rotation is under way. */
export interface KekEnv {
  INTEGRATIONS_KEK: string;
  INTEGRATIONS_KEK_PREVIOUS?: string;
}

/** The publisher's `sync_clock` reading, `(ms, ctr)`: what orders two devices' publishes. */
export interface Watermark {
  ms: number;
  ctr: number;
}

/** One table, as `GET …/projection/digests` answers it. `publishedAt` is Unix milliseconds. */
export interface TableDigest {
  digest: string;
  hlcMs: number;
  hlcCtr: number;
  rows: number;
  publishedAt: number;
}

export interface Digests {
  fields: IntegrationFields;
  marketplace: GroupSettings["marketplace"];
  tables: Partial<Record<Table, TableDigest>>;
}

/** `PUT …/settings`'s answer: the store's settings now, and whether this write made the store. */
export interface SettingsAnswer extends GroupSettings {
  created: boolean;
}

/** A store's answer to a projection `PUT`: a status and the JSON body the Worker sends. */
export interface Answer {
  status: number;
  body: Record<string, unknown>;
}

/**
 * The methods the Worker calls on a group's object over Workers RPC — `GroupStore` implements
 * them by handing each to a {@link Store}, and the suite's namespace hands out `Store`s.
 */
export interface StoreRpc {
  digests(group: string): Promise<Digests | null>;
  settings(
    group: string,
    wanted: GroupSettings,
    create: boolean,
    now: number,
  ): Promise<SettingsAnswer | null>;
  replace(
    group: string,
    table: Table,
    gz: Uint8Array,
    watermark: Watermark,
    digest: string,
    now: number,
  ): Promise<Answer>;
  exists(): Promise<boolean>;
  deleteAll(): Promise<void>;
  pendingIntents(group: string, since: number | null): Promise<PendingIntents | null>;
  claimIntent(group: string, id: string, now: number): Promise<Answer>;
  ackIntent(group: string, id: string, ack: Ack, now: number): Promise<Answer>;
  mintConsumer(
    group: string,
    integration: Integration,
    grant: { scopes: Scope[]; days: number },
    now: number,
  ): Promise<Answer>;
  listConsumers(group: string): Promise<Answer>;
  revokeConsumer(group: string, integration: Integration): Promise<void>;
  consumer(group: string, token: string, call: ConsumerCall, now: number): Promise<Answer>;
}

/** `GET …/intents`' answer: the pending intents, oldest first, and whether there were more. */
export interface PendingIntents {
  intents: Intent[];
  more: boolean;
}

/** A consumer route, as the router hands it to the group's object (plan §3.3). */
export type ConsumerCall =
  | {
      op: "entries";
      table: "collection_entries" | "wishlist_entries";
      q: string | null;
      folder: string | null;
    }
  | { op: "decks"; q: string | null }
  | { op: "deck"; uid: string }
  | { op: "folders" }
  | { op: "autocomplete"; kind: "collection" | "wishlist" | "decks" | "folders"; q: string | null }
  | { op: "post"; body: unknown }
  | { op: "intent"; id: string };

/** The machine-readable halves of a projection `PUT`'s refusals (plan §3.2). */
export const NO_STORE = "no_store";
export const BAD_PROJECTION = "bad_projection";
export const PROJECTION_LIMIT = "projection_limit";
export const SETTINGS_MISMATCH = "settings_mismatch";
export const STALE_PROJECTION = "stale_projection";

const NO_STORE_ANSWER: Answer = {
  status: 404,
  body: { error: "integrations are off for this group", code: NO_STORE },
};

const bad = (error: string): Answer => ({ status: 400, body: { error, code: BAD_PROJECTION } });

/** A refusal of the inbox's or a consumer route's, in the router's `{ error, code }` shape. */
const answer = (status: number, error: string, code: string, extra: object = {}): Answer => ({
  status,
  body: { error, code, ...extra },
});

/**
 * A consumer whose token does not hold, for any reason — a store that is gone, a MAC under another
 * key, a token past its `exp`, a `tid` revoked or replaced. **One answer for all of them**, the
 * relay's door's rule: which one it was is nothing a holder of a bad token needs to know.
 */
const UNAUTHORIZED: Answer = answer(401, "unauthorized", "unauthorized");

/** How many rows a consumer's read of entries answers with, at most — and of the overlay. */
const MAX_ENTRIES = 50;

/** How many decks `GET /c/decks` answers with, at most. */
const MAX_DECKS = 200;

/** How many choices an autocomplete answers with — Discord's own limit. */
const MAX_CHOICES = 25;

/** How many folders of a kind `GET /c/folders` answers with, at most. */
const MAX_FOLDERS = 1000;

/**
 * A search's text as a `LIKE` pattern on `name_norm`: normalised as the column is
 * (`projection.ts`'s `normaliseName`), its `%`, `_` and `\` escaped, and wrapped for a substring.
 * `null` for no search — every row.
 */
function likeOf(q: string | null): string | null {
  if (q === null) return null;
  const norm = normaliseName(q);
  if (norm === "") return null;
  return `%${norm.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * How many rows are sealed, or MACed, at once. WebCrypto's calls are async, and awaiting them one
 * by one costs a turn of the event loop each; a batch this size keeps the queue short without
 * holding a whole table's promises at once (`test/measure.test.ts`, run with `MEASURE=1`).
 */
const CRYPTO_BATCH = 512;

/**
 * How many times a replacement asks its transaction again after another publish of the same
 * table changed rows under it. Each round seals only what that publish moved, so this is a bound
 * on two devices racing, not on work; past it the device is told to try on its next round.
 */
const MAX_ROUNDS = 5;

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  `CREATE TABLE IF NOT EXISTS tables (
     tbl TEXT PRIMARY KEY, digest TEXT NOT NULL, hlc_ms INTEGER NOT NULL,
     hlc_ctr INTEGER NOT NULL, generation INTEGER NOT NULL, rows INTEGER NOT NULL,
     published_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS rows (
     tbl TEXT NOT NULL, uid TEXT NOT NULL, scryfall_id TEXT, name_norm TEXT, set_code TEXT,
     cn TEXT, finish TEXT, quantity INTEGER, folder_uid TEXT, kind TEXT, gen INTEGER NOT NULL,
     mac BLOB NOT NULL, sealed BLOB NOT NULL, PRIMARY KEY (tbl, uid)
   ) WITHOUT ROWID`,
];

/**
 * The inbox's three tables. **Apart from {@link SCHEMA} and made `IF NOT EXISTS` on every inbox
 * request** (`#inbox`), so a store made before them — by `wrangler dev`, before PR 3 — gains them
 * on first use rather than answering "no such table". A `CREATE … IF NOT EXISTS` over a table that
 * is there writes nothing.
 */
const INBOX_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS intents (
     id TEXT PRIMARY KEY, source TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL,
     created_at INTEGER NOT NULL, acked_at INTEGER, lease TEXT, lease_until INTEGER,
     ack_hlc_ms INTEGER, ack_hlc_ctr INTEGER, reason TEXT, name_norm TEXT, folder_uid TEXT,
     sealed BLOB NOT NULL
   ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS consumers (
     integration TEXT PRIMARY KEY, tid TEXT NOT NULL, scopes TEXT NOT NULL,
     issued_at INTEGER NOT NULL, exp INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS intent_days (
     integration TEXT NOT NULL, day INTEGER NOT NULL, count INTEGER NOT NULL,
     PRIMARY KEY (integration, day)
   ) WITHOUT ROWID`,
];

/** A stored row as a read selects it: what opening it needs. */
interface SealedRow {
  uid: string;
  gen: number;
  sealed: Uint8Array;
}

/** An intent's row as a read selects it. */
interface IntentRow {
  id: string;
  source: Source;
  kind: Kind;
  state: State;
  created_at: number;
  reason: string | null;
  ack_hlc_ms: number | null;
  ack_hlc_ctr: number | null;
  sealed: Uint8Array;
}

const INTENT_COLUMNS =
  "id, source, kind, state, created_at, reason, ack_hlc_ms, ack_hlc_ctr, sealed";

function intentRowOf(row: Record<string, unknown>): IntentRow {
  return {
    id: String(row.id),
    source: String(row.source) as Source,
    kind: String(row.kind) as Kind,
    state: String(row.state) as State,
    created_at: Number(row.created_at),
    reason: row.reason === null || row.reason === undefined ? null : String(row.reason),
    ack_hlc_ms:
      row.ack_hlc_ms === null || row.ack_hlc_ms === undefined ? null : Number(row.ack_hlc_ms),
    ack_hlc_ctr:
      row.ack_hlc_ctr === null || row.ack_hlc_ctr === undefined ? null : Number(row.ack_hlc_ctr),
    sealed: bytesOf(row.sealed),
  };
}

function sealedRowOf(row: Record<string, unknown>): SealedRow {
  return { uid: String(row.uid), gen: Number(row.gen), sealed: bytesOf(row.sealed) };
}

/** A blob as the binding takes it: an `ArrayBuffer` of exactly its bytes. */
const bufferOf = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

/** A blob as the binding hands it back: an `ArrayBuffer` in workerd, a `Uint8Array` in the suite. */
const bytesOf = (value: unknown): Uint8Array =>
  value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer);

/** Two MACs equal, byte for byte. Not a secret comparison: both sides are the store's own. */
function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let at = 0; at < a.length; at += 1) if (a[at] !== b[at]) return false;
  return true;
}

/** `work` over every item, `CRYPTO_BATCH` at a time, the results in order. */
async function batched<T, U>(items: T[], work: (item: T) => Promise<U>): Promise<U[]> {
  const out: U[] = [];
  for (let at = 0; at < items.length; at += CRYPTO_BATCH) {
    out.push(...(await Promise.all(items.slice(at, at + CRYPTO_BATCH).map(work))));
  }
  return out;
}

/** Is `(ms, ctr)` older than `held`? Equal is not: a republish that moved no clock is accepted. */
const older = (wm: Watermark, held: Watermark) =>
  wm.ms < held.ms || (wm.ms === held.ms && wm.ctr < held.ctr);

export class Store implements StoreRpc {
  #storage: SqlStorageLike;
  #env: KekEnv;

  constructor(storage: SqlStorageLike, env: KekEnv) {
    this.#storage = storage;
    this.#env = env;
  }

  #sql(query: string, ...bindings: unknown[]): Record<string, unknown>[] {
    return this.#storage.sql.exec(query, ...bindings).toArray();
  }

  /**
   * Is there a store in this object? **Asked of `sqlite_master` first**, because asking `meta`
   * itself on an object that never had one is "no such table", and creating the table to ask
   * would be a write on a path that must write nothing.
   */
  #exists(): boolean {
    const tables = this.#sql(
      "SELECT name FROM sqlite_master WHERE type = ? AND name = ?",
      "table",
      "meta",
    );
    return tables.length > 0 && this.#meta("data_key") !== null;
  }

  #meta(key: string): string | null {
    const row = this.#sql("SELECT value FROM meta WHERE key = ?", key)[0];
    return row === undefined ? null : String(row.value);
  }

  #setMeta(key: string, value: string): void {
    this.#sql(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  /** The stored settings. Written only by `settings`, so a store always has them. */
  #settings(): GroupSettings {
    const fields = parseFields(JSON.parse(this.#meta("fields") ?? "null"));
    const marketplace = this.#meta("marketplace");
    if (fields === null || !isMarketplace(marketplace)) {
      throw new Error("a store holds unreadable settings");
    }
    return { fields, marketplace };
  }

  /**
   * The object answers for one group, and says so if asked about another. `idFromName(group)`
   * makes that impossible from this Worker's router; the check is for the day something else
   * routes here.
   */
  #own(group: string): void {
    const held = this.#meta("group");
    if (held !== group) throw new Error("this store belongs to another group");
  }

  /**
   * **KEK rotation, on any request to a store**: when the data key was wrapped under a KEK that
   * is not `INTEGRATIONS_KEK` — its fingerprint says so — open it under
   * `INTEGRATIONS_KEK_PREVIOUS` and wrap it under the current one. The rows are under the data
   * key and do not move. A store whose key neither secret opens throws, naming the binding: it
   * is a misconfigured Worker, and wiping the store to make a fresh key would hide that.
   */
  async #rotate(group: string): Promise<void> {
    // Read before the first await, while the caller's `#exists()` still holds: a `deleteAll` can
    // land at any await below, and `meta` is then no table at all.
    const held = this.#meta("kek");
    const wrapped = this.#meta("data_key") ?? "";
    const current = await kekFingerprint(this.#env.INTEGRATIONS_KEK ?? "");
    if (held === current) return;
    const kek = await importKek(this.#env.INTEGRATIONS_KEK, "INTEGRATIONS_KEK");
    let moved: string;
    try {
      const previous = await importKek(
        this.#env.INTEGRATIONS_KEK_PREVIOUS,
        "INTEGRATIONS_KEK_PREVIOUS",
      );
      moved = await rewrap(wrapped, group, previous, kek);
    } catch {
      throw new Error(
        "a store's data key is wrapped under neither INTEGRATIONS_KEK nor INTEGRATIONS_KEK_PREVIOUS",
      );
    }
    this.#storage.transactionSync(() => {
      // Emptied, or rotated by another request, while this one awaited: write only over what
      // was read.
      if (!this.#exists() || this.#meta("data_key") !== wrapped) return;
      this.#setMeta("data_key", moved);
      this.#setMeta("kek", current);
    });
  }

  /** The data key. The wrapped one is read before the first await, for `#rotate`'s reason. */
  async #dataKey(group: string): Promise<Uint8Array> {
    const wrapped = this.#meta("data_key") ?? "";
    const kek = await importKek(this.#env.INTEGRATIONS_KEK, "INTEGRATIONS_KEK");
    return unwrapDataKey(kek, wrapped, group);
  }

  async digests(group: string): Promise<Digests | null> {
    if (!this.#exists()) return null;
    this.#own(group);
    await this.#rotate(group);
    if (!this.#exists()) return null;
    const tables: Partial<Record<Table, TableDigest>> = {};
    for (const row of this.#sql(
      "SELECT tbl, digest, hlc_ms, hlc_ctr, rows, published_at FROM tables ORDER BY tbl",
    )) {
      tables[String(row.tbl) as Table] = {
        digest: String(row.digest),
        hlcMs: Number(row.hlc_ms),
        hlcCtr: Number(row.hlc_ctr),
        rows: Number(row.rows),
        publishedAt: Number(row.published_at),
      };
    }
    return { ...this.#settings(), tables };
  }

  /**
   * Make the store, or change its settings — the field policy and the marketplace. **A change of
   * either drops every projected table at once** (plan §2): narrowing the policy — notes off —
   * takes the notes off the server before any device republishes, and a new marketplace leaves no
   * table priced under the old one; the digests then name no table, and every device's next round
   * sends all six under the new settings. The same settings again change nothing.
   *
   * **`create: false` never makes a store**, and answers `null` when there is none: a change of
   * settings from a device that has not heard of another's switch-off must not bring the store
   * back. Only the switch that turns integrations on sends `create: true`.
   */
  async settings(
    group: string,
    wanted: GroupSettings,
    create: boolean,
    now: number,
  ): Promise<SettingsAnswer | null> {
    if (this.#exists()) {
      this.#own(group);
      await this.#rotate(group);
      // Emptied while it rotated — a switch-off between the two: a switch-on makes it again, a
      // change of settings finds nothing.
      if (this.#exists()) return this.#storage.transactionSync(() => this.#change(wanted));
    }
    if (!create) return null;
    // A new store: the data key is made and wrapped before the transaction, since WebCrypto is
    // async and the transaction is not.
    const kek = await importKek(this.#env.INTEGRATIONS_KEK, "INTEGRATIONS_KEK");
    const wrapped = await wrapDataKey(kek, newDataKey(), group);
    const fingerprint = await kekFingerprint(this.#env.INTEGRATIONS_KEK);
    return this.#storage.transactionSync(() => {
      // Made by another request while this one awaited: then this is a change of settings on it.
      if (this.#exists()) return this.#change(wanted);
      for (const statement of [...SCHEMA, ...INBOX_SCHEMA]) this.#sql(statement);
      this.#setMeta("group", group);
      // This store's own name, apart from every store this object held before it and will hold
      // after: what a replacement holds itself to across its awaits (`replace`). Not the data key,
      // which a KEK rotation rewraps.
      this.#setMeta("store_id", toBase64url(crypto.getRandomValues(new Uint8Array(16))));
      this.#setMeta("data_key", wrapped);
      this.#setMeta("kek", fingerprint);
      this.#setMeta("fields", JSON.stringify(wanted.fields));
      this.#setMeta("marketplace", wanted.marketplace);
      this.#setMeta("created_at", String(now));
      this.#setMeta("generation", "0");
      return { fields: wanted.fields, marketplace: wanted.marketplace, created: true };
    });
  }

  /** Inside a transaction, on a store that exists. */
  #change(wanted: GroupSettings): SettingsAnswer {
    const held = this.#settings();
    const same =
      held.marketplace === wanted.marketplace &&
      (Object.keys(wanted.fields) as FieldName[]).every(
        (name) => held.fields[name] === wanted.fields[name],
      );
    if (!same) {
      this.#sql("DELETE FROM rows");
      this.#sql("DELETE FROM tables");
      this.#setMeta("fields", JSON.stringify(wanted.fields));
      this.#setMeta("marketplace", wanted.marketplace);
    }
    return { fields: wanted.fields, marketplace: wanted.marketplace, created: false };
  }

  /**
   * The store's refusal of a document that passed the Worker's own checks, or `null`: a field
   * policy or a marketplace that is not the store's (`409 settings_mismatch`, with the store's
   * `fields` and `marketplace`, from which the device projects again), or a watermark older than
   * the one the table holds (`409 stale_projection`, with that one). Asked before the sealing and
   * again inside the transaction that writes.
   */
  #refusal(
    table: Table,
    doc: Pick<Document, "fields" | "marketplace">,
    watermark: Watermark,
  ): Answer | null {
    const held = this.#settings();
    const wanted = enabledNames(held.fields);
    if (
      held.marketplace !== doc.marketplace ||
      wanted.length !== doc.fields.length ||
      wanted.some((name, at) => name !== doc.fields[at])
    ) {
      return {
        status: 409,
        body: {
          error: "that projection was made under other settings than the store's",
          code: SETTINGS_MISMATCH,
          fields: held.fields,
          marketplace: held.marketplace,
        },
      };
    }
    const row = this.#sql("SELECT hlc_ms, hlc_ctr FROM tables WHERE tbl = ?", table)[0];
    if (row !== undefined) {
      const standing = { ms: Number(row.hlc_ms), ctr: Number(row.hlc_ctr) };
      if (older(watermark, standing)) {
        return {
          status: 409,
          body: {
            error: "a newer projection of that table is already stored",
            code: STALE_PROJECTION,
            hlcMs: standing.ms,
            hlcCtr: standing.ctr,
          },
        };
      }
    }
    return null;
  }

  /**
   * Replace one table with the document `gz` holds — writing only what changed.
   * `PUT /g/{group}/projection/{table}`'s whole decision, after the Worker's gate and its size and
   * header checks.
   *
   * Every row is MACed first (`rowMac`), then the transaction compares those MACs with the ones
   * the store holds. **Unchanged rows are left alone; new and changed rows are sealed** under a
   * generation this replacement takes, and only when it has any; rows whose `uid` is gone are
   * deleted. The first round seals nothing and asks the transaction which rows want sealing — a
   * republish that moved nothing is then one read and the `tables` row, and one that moved a card
   * seals that card. A round that finds a row changed under it by another publish seals that row
   * and asks again, up to {@link MAX_ROUNDS}.
   */
  async replace(
    group: string,
    table: Table,
    gz: Uint8Array,
    watermark: Watermark,
    digest: string,
    now: number,
  ): Promise<Answer> {
    if (!this.#exists()) return NO_STORE_ANSWER;
    this.#own(group);
    await this.#rotate(group);

    const inflated = await inflate(gz);
    if ("over" in inflated) {
      return {
        status: 413,
        body: {
          error: `that projection inflates past ${MAX_INFLATED_BYTES / (1024 * 1024)} MiB`,
          code: PROJECTION_LIMIT,
        },
      };
    }
    if ("bad" in inflated) return bad("that projection is not gzip");
    let parsed: unknown;
    try {
      parsed = JSON.parse(inflated.text);
    } catch {
      return bad("that projection is not JSON");
    }
    const doc = validateDocument(parsed, table);
    if (typeof doc === "string") return bad(doc);

    // The store's own say before any key is drawn: a refused document costs no crypto.
    if (!this.#exists()) return NO_STORE_ANSWER;
    const early = this.#refusal(table, doc, watermark);
    if (early !== null) return early;

    // **The store this replacement is for**, read with its data key, before the first await: a
    // switch-off and a switch-on can both land while the MACs and the seals are awaited, and the
    // store that answers afterwards — same group, same policy — holds another data key. Rows
    // sealed under this one would never open there.
    const storeId = this.#meta("store_id");
    const dataKey = await this.#dataKey(group);
    const macWith = await macKey(dataKey);
    const macs = await batched(doc.rows, (row) => rowMac(macWith, table, row));

    const sealed = new Map<string, Uint8Array>();
    let generation: number | null = null;
    for (let round = 1; ; round += 1) {
      const outcome = this.#storage.transactionSync(() =>
        this.#write(table, doc, storeId, macs, sealed, generation, watermark, digest, now),
      );
      if ("answer" in outcome) return outcome.answer;
      if (round >= MAX_ROUNDS) return this.#busy(table);

      // A generation of this replacement's own, taken the first time it has a row to seal —
      // the generation is in the row's key. One that then goes unused costs nothing.
      if (generation === null) {
        const taken = this.#storage.transactionSync((): number | Answer => {
          if (!this.#exists()) return NO_STORE_ANSWER;
          if (this.#meta("store_id") !== storeId) return this.#remade(table);
          const next = Number(this.#meta("generation") ?? "0") + 1;
          this.#setMeta("generation", String(next));
          return next;
        });
        if (typeof taken !== "number") return taken;
        generation = taken;
      }
      const key = await rowKey(dataKey, table, generation);
      const blobs = await batched(outcome.unsealed, (at) => sealRow(key, table, doc.rows[at]));
      outcome.unsealed.forEach((at, i) => sealed.set(doc.rows[at].uid, blobs[i]));
    }
  }

  /**
   * One round of a replacement, **inside its transaction**: the answer, or the rows that want
   * sealing before it can write. Decided again from the store as it stands — a `deleteAll`, a
   * policy change or another publish may have landed while the MACs or the seals were awaited.
   */
  #write(
    table: Table,
    doc: Document,
    storeId: string | null,
    macs: Uint8Array[],
    sealed: Map<string, Uint8Array>,
    generation: number | null,
    watermark: Watermark,
    digest: string,
    now: number,
  ): { answer: Answer } | { unsealed: number[] } {
    if (!this.#exists()) return { answer: NO_STORE_ANSWER };
    if (this.#meta("store_id") !== storeId) return { answer: this.#remade(table) };
    const late = this.#refusal(table, doc, watermark);
    if (late !== null) return { answer: late };

    const held = new Map<string, Uint8Array>();
    for (const row of this.#sql("SELECT uid, mac FROM rows WHERE tbl = ?", table)) {
      held.set(String(row.uid), bytesOf(row.mac));
    }
    const unsealed: number[] = [];
    const writes: number[] = [];
    doc.rows.forEach((row, at) => {
      const was = held.get(row.uid);
      if (was !== undefined && same(was, macs[at])) return;
      (sealed.has(row.uid) ? writes : unsealed).push(at);
    });
    if (unsealed.length > 0) return { unsealed };

    const kept = new Set(doc.rows.map((row) => row.uid));
    for (const uid of held.keys()) {
      if (!kept.has(uid)) this.#sql("DELETE FROM rows WHERE tbl = ? AND uid = ?", table, uid);
    }
    for (const at of writes) {
      const row = doc.rows[at];
      const clear = clearColumns(table, row);
      this.#sql(
        `INSERT INTO rows (tbl, uid, scryfall_id, name_norm, set_code, cn, finish, quantity,
           folder_uid, kind, gen, mac, sealed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tbl, uid) DO UPDATE SET scryfall_id = excluded.scryfall_id,
           name_norm = excluded.name_norm, set_code = excluded.set_code, cn = excluded.cn,
           finish = excluded.finish, quantity = excluded.quantity,
           folder_uid = excluded.folder_uid, kind = excluded.kind, gen = excluded.gen,
           mac = excluded.mac, sealed = excluded.sealed`,
        table,
        row.uid,
        clear.scryfall_id,
        clear.name_norm,
        clear.set_code,
        clear.cn,
        clear.finish,
        clear.quantity,
        clear.folder_uid,
        clear.kind,
        generation,
        bufferOf(macs[at]),
        bufferOf(sealed.get(row.uid)!),
      );
    }
    // The table's generation is the newest any of its rows was sealed in; a round that sealed
    // nothing leaves it as it was.
    const standing = this.#sql("SELECT generation FROM tables WHERE tbl = ?", table)[0];
    this.#sql(
      `INSERT INTO tables (tbl, digest, hlc_ms, hlc_ctr, generation, rows, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tbl) DO UPDATE SET digest = excluded.digest, hlc_ms = excluded.hlc_ms,
           hlc_ctr = excluded.hlc_ctr, generation = excluded.generation, rows = excluded.rows,
           published_at = excluded.published_at`,
      table,
      digest,
      watermark.ms,
      watermark.ctr,
      writes.length > 0 ? generation : Number(standing?.generation ?? 0),
      doc.rows.length,
      now,
    );
    return {
      answer: {
        status: 200,
        body: {
          table,
          digest,
          rows: doc.rows.length,
          hlcMs: watermark.ms,
          hlcCtr: watermark.ctr,
        },
      },
    };
  }

  /**
   * Two devices publishing one table at once, past {@link MAX_ROUNDS}: the device is told the
   * table is held at the watermark the store has, as a stale publish is, and asks again on its
   * next round.
   */
  #busy(table: Table): Answer {
    return this.#sendAgain(
      table,
      "another device kept publishing that table; it will be sent again",
    );
  }

  /**
   * **The store was switched off and on again while this replacement awaited** — a store of the
   * same group, under another data key. Answered as a stale publish is (`409 stale_projection`,
   * with the new store's watermark for the table, or zero): the device keeps the store as on, and
   * its next round finds this table's digest missing and sends it again, sealed under the new
   * key. A `404 no_store` would tell it the store is off, which it is not, and it would stop
   * asking for hours.
   */
  #remade(table: Table): Answer {
    return this.#sendAgain(
      table,
      "the store was switched off and on again while that projection was sent; it will be sent again",
    );
  }

  #sendAgain(table: Table, error: string): Answer {
    const row = this.#exists()
      ? this.#sql("SELECT hlc_ms, hlc_ctr FROM tables WHERE tbl = ?", table)[0]
      : undefined;
    return {
      status: 409,
      body: {
        error,
        code: STALE_PROJECTION,
        hlcMs: Number(row?.hlc_ms ?? 0),
        hlcCtr: Number(row?.hlc_ctr ?? 0),
      },
    };
  }

  /**
   * Whether this object holds a store, asking nothing else and writing nothing — what the router
   * and the lapse pass read after forgetting a group's row, so a store made again in between gets
   * its row back (`worker.ts`'s `handleDelete`, `lapse.ts`).
   */
  async exists(): Promise<boolean> {
    return this.#exists();
  }

  /**
   * Empty the object — every table, the data key with them — as switching integrations off and
   * a lapsed membership both do. Whether or not there was a store: an empty object's
   * `deleteAll` is a no-op, and the caller's answer is the same either way.
   */
  async deleteAll(): Promise<void> {
    await this.#storage.deleteAll();
  }

  // -------------------------------------------------------------------------------------
  // The inbox — device routes (plan §3.2)
  // -------------------------------------------------------------------------------------

  /**
   * The inbox's tables, on a store that has them or gains them now ({@link INBOX_SCHEMA}). Asked
   * after `#exists()` and before any inbox statement.
   */
  #inbox(): void {
    for (const statement of INBOX_SCHEMA) this.#sql(statement);
  }

  /**
   * One store's preamble for an inbox or consumer request: a store there, this group's, its key
   * under the current KEK — and still there after rotating, which awaits.
   */
  async #ready(group: string): Promise<boolean> {
    if (!this.#exists()) return false;
    this.#own(group);
    await this.#rotate(group);
    if (!this.#exists()) return false;
    this.#inbox();
    return true;
  }

  /**
   * **Acked intents past {@link KEEP_ACKED_MS}, forgotten**, and the day counters before
   * yesterday — inside the transaction of a write to the inbox, so a store nobody writes to keeps
   * what it has and pays no write for tidying. A delete that finds nothing writes nothing.
   */
  #tidy(now: number): void {
    this.#sql("DELETE FROM intents WHERE state != 'pending' AND acked_at < ?", now - KEEP_ACKED_MS);
    this.#sql("DELETE FROM intent_days WHERE day < ?", utcDay(now) - 1);
  }

  /** The intent `row`, opened, as the Worker answers one. */
  async #intentOf(key: CryptoKey, row: IntentRow): Promise<Intent> {
    const opened = (await openIntent(key, row.id, row.sealed)) as {
      payload: Record<string, unknown>;
      confirmedBy: string | null;
    };
    return {
      id: row.id,
      group: this.#meta("group") ?? "",
      source: row.source,
      kind: row.kind,
      payload: opened.payload,
      createdAt: row.created_at,
      confirmedBy: opened.confirmedBy,
      state: row.state,
      reason: row.reason,
    };
  }

  /**
   * `GET /g/{group}/intents` — **the pending intents, oldest first**, at most
   * {@link MAX_PENDING_LISTED}, those created after `since` (Unix ms) when it is given; `null` for
   * no store. A claimed intent is still pending, and is listed: the device's claim is what learns
   * that another holds it.
   */
  async pendingIntents(group: string, since: number | null): Promise<PendingIntents | null> {
    if (!(await this.#ready(group))) return null;
    const dataKey = await this.#dataKey(group);
    const key = await intentKey(dataKey);
    if (!this.#exists()) return null;
    this.#inbox();
    const rows = this.#sql(
      `SELECT ${INTENT_COLUMNS} FROM intents WHERE state = 'pending' AND created_at > ?
         ORDER BY created_at, id LIMIT ?`,
      since ?? -1,
      MAX_PENDING_LISTED + 1,
    ).map(intentRowOf);
    const more = rows.length > MAX_PENDING_LISTED;
    const intents = await Promise.all(
      rows.slice(0, MAX_PENDING_LISTED).map((row) => this.#intentOf(key, row)),
    );
    return { intents, more };
  }

  /**
   * `POST /g/{group}/intents/{id}/claim` — **a lease of {@link LEASE_MS} on a pending intent**, so
   * one device applies it (plan §2: an add is a quantity, and two devices applying one intent would
   * add the card twice). Refused while another live lease holds it (`409 claimed`) and once it is
   * acked (`409 already_acked`, with its state). An expired lease is anybody's.
   */
  async claimIntent(group: string, id: string, now: number): Promise<Answer> {
    if (!(await this.#ready(group))) return NO_STORE_ANSWER;
    return this.#storage.transactionSync(() => {
      if (!this.#exists()) return NO_STORE_ANSWER;
      this.#inbox();
      const row = this.#sql("SELECT state, lease, lease_until FROM intents WHERE id = ?", id)[0];
      if (row === undefined) return answer(404, "no such intent in this store", NO_INTENT);
      if (row.state !== "pending") {
        return answer(409, "that intent has been acked already", ALREADY_ACKED, {
          state: String(row.state),
        });
      }
      if (row.lease !== null && Number(row.lease_until) > now) {
        return answer(409, "another device is applying that intent", CLAIMED);
      }
      const lease = randomId();
      const leaseUntil = now + LEASE_MS;
      this.#sql(
        "UPDATE intents SET lease = ?, lease_until = ? WHERE id = ?",
        lease,
        leaseUntil,
        id,
      );
      return { status: 200, body: { id, lease, leaseUntil } };
    });
  }

  /**
   * `POST /g/{group}/intents/{id}/ack` — **the outcome**: `applied` by the device holding the
   * intent's lease, with its watermark after the write; or `refused`, with a reason, by any device
   * no other live lease stands in front of (every device refuses an intent for the same reason).
   * **An ack repeating the held state is a 200**, so a device sending an ack it owed after a crash
   * is told it landed; another state is `409 already_acked`.
   *
   * The watermark is what keeps the overlay drawing an applied add until a published table
   * reflects it ({@link consumer}).
   */
  async ackIntent(group: string, id: string, ack: Ack, now: number): Promise<Answer> {
    if (!(await this.#ready(group))) return NO_STORE_ANSWER;
    return this.#storage.transactionSync(() => {
      if (!this.#exists()) return NO_STORE_ANSWER;
      this.#inbox();
      const row = this.#sql("SELECT state, lease, lease_until FROM intents WHERE id = ?", id)[0];
      if (row === undefined) return answer(404, "no such intent in this store", NO_INTENT);
      if (row.state !== "pending") {
        if (row.state === ack.state) return { status: 200, body: { id, state: ack.state } };
        return answer(409, "that intent has been acked already", ALREADY_ACKED, {
          state: String(row.state),
        });
      }
      const held = row.lease === null ? null : String(row.lease);
      const live = held !== null && Number(row.lease_until) > now;
      if (ack.state === "applied" ? ack.lease !== held : live && ack.lease !== held) {
        return answer(409, "another device is applying that intent", CLAIMED);
      }
      this.#sql(
        `UPDATE intents SET state = ?, acked_at = ?, reason = ?, ack_hlc_ms = ?, ack_hlc_ctr = ?
           WHERE id = ?`,
        ack.state,
        now,
        ack.reason,
        ack.hlcMs,
        ack.hlcCtr,
        id,
      );
      this.#tidy(now);
      return { status: 200, body: { id, state: ack.state } };
    });
  }

  // -------------------------------------------------------------------------------------
  // Consumer tokens — device routes (plan §3.2)
  // -------------------------------------------------------------------------------------

  /**
   * `POST /g/{group}/consumers/{integration}` — **a token for an integration**, signed under the
   * group's consumer key, **replacing any the integration held**: the row keeps one `tid` per
   * integration, so the old token stops at the next request it makes. `exp` is Unix seconds,
   * `days` from now.
   *
   * The token is signed before the transaction (WebCrypto is async), under the data key of the
   * store as it stood; the transaction then holds itself to that store (`store_id`) — a store
   * switched off and on in between has another key, and the token is signed again under it.
   */
  async mintConsumer(
    group: string,
    integration: Integration,
    grant: { scopes: Scope[]; days: number },
    now: number,
  ): Promise<Answer> {
    for (let round = 1; round <= MAX_ROUNDS; round += 1) {
      if (!(await this.#ready(group))) return NO_STORE_ANSWER;
      const storeId = this.#meta("store_id");
      const key = await consumerKey(await this.#dataKey(group));
      const claims: Claims = {
        grp: group,
        int: integration,
        scp: grant.scopes,
        exp: Math.floor(now / 1000) + grant.days * 86_400,
        tid: randomId(),
      };
      const token = await signToken(key, claims);
      const outcome = this.#storage.transactionSync((): Answer | null => {
        if (!this.#exists()) return NO_STORE_ANSWER;
        if (this.#meta("store_id") !== storeId) return null;
        this.#inbox();
        this.#sql(
          `INSERT INTO consumers (integration, tid, scopes, issued_at, exp) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (integration) DO UPDATE SET tid = excluded.tid, scopes = excluded.scopes,
               issued_at = excluded.issued_at, exp = excluded.exp`,
          integration,
          claims.tid,
          JSON.stringify(claims.scp),
          now,
          claims.exp,
        );
        return {
          status: 200,
          body: { integration, token, scopes: claims.scp, exp: claims.exp },
        };
      });
      if (outcome !== null) return outcome;
    }
    throw new Error("the store kept being switched off and on while a token was minted");
  }

  /** `GET /g/{group}/consumers` — the tokens live, one an integration, without the tokens. */
  async listConsumers(group: string): Promise<Answer> {
    if (!(await this.#ready(group))) return NO_STORE_ANSWER;
    const consumers = this.#sql(
      "SELECT integration, scopes, issued_at, exp FROM consumers ORDER BY integration",
    ).map((row) => ({
      integration: String(row.integration),
      scopes: scopesOf(String(row.scopes)),
      issuedAt: Number(row.issued_at),
      exp: Number(row.exp),
    }));
    return { status: 200, body: { consumers } };
  }

  /**
   * `DELETE /g/{group}/consumers/{integration}` — the integration's token, revoked: its row goes,
   * and the next request it makes is a 401. Nothing to do on a store with none, or no store.
   */
  async revokeConsumer(group: string, integration: Integration): Promise<void> {
    if (!(await this.#ready(group))) return;
    this.#sql("DELETE FROM consumers WHERE integration = ?", integration);
  }

  // -------------------------------------------------------------------------------------
  // Consumer routes (plan §3.3)
  // -------------------------------------------------------------------------------------

  /**
   * The scopes a token's integration holds now, or `null` when its row no longer names this token
   * (revoked, or replaced by a re-mint). Synchronous: asked inside the stretch that reads.
   */
  #live(claims: Claims): Scope[] | null {
    const row = this.#sql("SELECT tid, scopes FROM consumers WHERE integration = ?", claims.int)[0];
    if (row === undefined || String(row.tid) !== claims.tid) return null;
    return scopesOf(String(row.scopes));
  }

  /**
   * **Every consumer route's door, then the route.** A store; a token whose MAC holds under its
   * consumer key; `exp` not passed; and its integration's row still holding its `tid` — asked after
   * the awaits, in the same stretch as the read, so a revoke that landed while the MAC was checked
   * is honoured. Then the scopes are the row's, and the route is {@link ConsumerCall}'s.
   */
  async consumer(group: string, token: string, call: ConsumerCall, now: number): Promise<Answer> {
    if (!(await this.#ready(group))) return UNAUTHORIZED;
    const storeId = this.#meta("store_id");
    const dataKey = await this.#dataKey(group);
    const claims = await verifyToken(await consumerKey(dataKey), token);
    if (claims === null || claims.grp !== group || claims.exp * 1000 <= now) return UNAUTHORIZED;
    const sealedWith = await intentKey(dataKey);
    if (!this.#exists() || this.#meta("store_id") !== storeId) return UNAUTHORIZED;
    this.#inbox();
    const scopes = this.#live(claims);
    if (scopes === null) return UNAUTHORIZED;
    const keys = { data: dataKey, intent: sealedWith };
    switch (call.op) {
      case "entries":
        return this.#entries(call.table, scopes, call.q, call.folder, keys);
      case "decks":
        return this.#decks(scopes, call.q, dataKey);
      case "deck":
        return this.#deck(scopes, call.uid, dataKey);
      case "folders":
        return this.#folders(scopes, dataKey);
      case "autocomplete":
        return this.#autocomplete(scopes, call.kind, call.q, dataKey);
      case "post":
        return this.#post(group, claims, scopes, call.body, sealedWith, storeId, now);
      case "intent":
        return this.#intent(claims, call.id, sealedWith);
    }
  }

  /** Stored rows, opened — each under its generation's key, derived once a generation. */
  async #open(
    table: Table,
    rows: SealedRow[],
    dataKey: Uint8Array,
  ): Promise<Record<string, unknown>[]> {
    const keys = new Map<number, Promise<CryptoKey>>();
    return Promise.all(
      rows.map(async (row) => {
        let key = keys.get(row.gen);
        if (key === undefined) {
          key = rowKey(dataKey, table, row.gen);
          keys.set(row.gen, key);
        }
        return (await openRow(await key, table, row.uid, row.sealed)) as Record<string, unknown>;
      }),
    );
  }

  /**
   * Rows of `table` whose name contains `q` (all when `null`), in container `folder` when given,
   * by name then uid, at most `limit` — and whether there were more.
   */
  #matching(
    table: Table,
    like: string | null,
    folder: string | null,
    limit: number,
  ): { rows: SealedRow[]; more: boolean } {
    const where = ["tbl = ?"];
    const bindings: unknown[] = [table];
    if (like !== null) {
      where.push("name_norm LIKE ? ESCAPE '\\'");
      bindings.push(like);
    }
    if (folder !== null) {
      where.push("folder_uid = ?");
      bindings.push(folder);
    }
    const found = this.#sql(
      `SELECT uid, gen, sealed FROM rows WHERE ${where.join(" AND ")}
         ORDER BY name_norm, uid LIMIT ?`,
      ...bindings,
      limit + 1,
    ).map(sealedRowOf);
    return { rows: found.slice(0, limit), more: found.length > limit };
  }

  /**
   * `GET /c/collection` and `/c/wishlist` — **the projection's rows, then the overlay** (plan §3.3):
   * every intent of the table's kind that is pending, or applied with an ack watermark newer than
   * the table's held one (or a table never published), matching the same search and folder,
   * appended as a row with `uid: null`. **A refused intent is never drawn**; an applied one stays
   * until a publish at or past its watermark reflects it, because the round acks before its own
   * projection half publishes and a device that cannot publish the table leaves it to another.
   */
  async #entries(
    table: "collection_entries" | "wishlist_entries",
    scopes: Scope[],
    q: string | null,
    folder: string | null,
    keys: { data: Uint8Array; intent: CryptoKey },
  ): Promise<Answer> {
    const needed: Scope = table === "collection_entries" ? "collection:read" : "wishlist:read";
    if (!scopes.includes(needed)) return answer(403, `that token may not read ${table}`, SCOPE);
    const like = likeOf(q);
    const settings = this.#settings();
    const held = this.#sql(
      "SELECT hlc_ms, hlc_ctr, published_at FROM tables WHERE tbl = ?",
      table,
    )[0];
    const { rows, more } = this.#matching(table, like, folder, MAX_ENTRIES);

    const where = ["kind = ?", "state IN ('pending', 'applied')"];
    const bindings: unknown[] = [
      table === "collection_entries" ? "collection.add" : "wishlist.add",
    ];
    if (like !== null) {
      where.push("name_norm LIKE ? ESCAPE '\\'");
      bindings.push(like);
    }
    if (folder !== null) {
      where.push("folder_uid = ?");
      bindings.push(folder);
    }
    const candidates = this.#sql(
      `SELECT ${INTENT_COLUMNS} FROM intents WHERE ${where.join(" AND ")}
         ORDER BY created_at, id`,
      ...bindings,
    ).map(intentRowOf);
    const unreflected = candidates.filter((intent) => {
      if (intent.state === "pending" || held === undefined) return true;
      const [ms, ctr] = [Number(held.hlc_ms), Number(held.hlc_ctr)];
      const ackMs = intent.ack_hlc_ms ?? 0;
      const ackCtr = intent.ack_hlc_ctr ?? 0;
      return ackMs > ms || (ackMs === ms && ackCtr > ctr);
    });

    const opened = await this.#open(table, rows, keys.data);
    const overlay = await Promise.all(
      unreflected
        .slice(0, MAX_ENTRIES)
        .map(async (row) => overlayRow(await this.#intentOf(keys.intent, row))),
    );
    return {
      status: 200,
      body: {
        rows: [...opened, ...overlay],
        more: more || unreflected.length > MAX_ENTRIES,
        publishedAt: held === undefined ? null : Number(held.published_at),
        fields: settings.fields,
        marketplace: settings.marketplace,
      },
    };
  }

  /** `GET /c/decks` — the decks whose name contains `q`, by name. */
  async #decks(scopes: Scope[], q: string | null, dataKey: Uint8Array): Promise<Answer> {
    if (!scopes.includes("decks:read")) return answer(403, "that token may not read decks", SCOPE);
    const { rows, more } = this.#matching("decks", likeOf(q), null, MAX_DECKS);
    return { status: 200, body: { decks: await this.#open("decks", rows, dataKey), more } };
  }

  /** `GET /c/decks/{uid}` — one deck and its cards (the deck cards whose container is it). */
  async #deck(scopes: Scope[], uid: string, dataKey: Uint8Array): Promise<Answer> {
    if (!scopes.includes("decks:read")) return answer(403, "that token may not read decks", SCOPE);
    const deck = this.#sql(
      "SELECT uid, gen, sealed FROM rows WHERE tbl = 'decks' AND uid = ?",
      uid,
    ).map(sealedRowOf);
    if (deck.length === 0) return answer(404, "no deck of that uid", NO_DECK);
    const cards = this.#sql(
      "SELECT uid, gen, sealed FROM rows WHERE tbl = 'deck_cards' AND folder_uid = ? ORDER BY uid",
      uid,
    ).map(sealedRowOf);
    const [opened] = await this.#open("decks", deck, dataKey);
    return {
      status: 200,
      body: { deck: opened, cards: await this.#open("deck_cards", cards, dataKey) },
    };
  }

  /** `GET /c/folders` — each folder list the token may read, by name: none is a 403. */
  async #folders(scopes: Scope[], dataKey: Uint8Array): Promise<Answer> {
    const body: Record<string, unknown> = {};
    const lists: [Scope, Table, string][] = [
      ["collection:read", "collection_folders", "collection"],
      ["wishlist:read", "wishlist_folders", "wishlist"],
    ];
    for (const [scope, table, name] of lists) {
      if (!scopes.includes(scope)) continue;
      const { rows } = this.#matching(table, null, null, MAX_FOLDERS);
      body[name] = await this.#open(table, rows, dataKey);
    }
    if (Object.keys(body).length === 0) {
      return answer(403, "that token may read no folders", SCOPE);
    }
    return { status: 200, body };
  }

  /**
   * `GET /c/autocomplete` — at most {@link MAX_CHOICES} `{ name, value }`: distinct card names
   * (one row opened per name — its value is the name), deck names (value: the deck's uid), and
   * `kind = 'user'` collection folder names (value: the folder's uid).
   */
  async #autocomplete(
    scopes: Scope[],
    kind: "collection" | "wishlist" | "decks" | "folders",
    q: string | null,
    dataKey: Uint8Array,
  ): Promise<Answer> {
    const needed: Scope =
      kind === "wishlist" ? "wishlist:read" : kind === "decks" ? "decks:read" : "collection:read";
    if (!scopes.includes(needed)) return answer(403, `that token may not read ${kind}`, SCOPE);
    const like = likeOf(q);
    const filter = like === null ? "" : " AND name_norm LIKE ? ESCAPE '\\'";
    const bindings = like === null ? [] : [like];
    let choices: { name: string; value: string }[];
    if (kind === "collection" || kind === "wishlist") {
      const table: Table = kind === "collection" ? "collection_entries" : "wishlist_entries";
      const rows = this.#sql(
        `SELECT uid, gen, sealed FROM rows WHERE tbl = ? AND uid IN (
           SELECT min(uid) FROM rows WHERE tbl = ?${filter} AND name_norm IS NOT NULL
             GROUP BY name_norm ORDER BY name_norm LIMIT ?)`,
        table,
        table,
        ...bindings,
        MAX_CHOICES,
      ).map(sealedRowOf);
      const names = (await this.#open(table, rows, dataKey)).map((row) => String(row.name));
      choices = names
        .sort((a, b) => (normaliseName(a) < normaliseName(b) ? -1 : 1))
        .map((name) => ({ name, value: name }));
    } else {
      const table: Table = kind === "decks" ? "decks" : "collection_folders";
      const rows = this.#sql(
        `SELECT uid, gen, sealed FROM rows WHERE tbl = ?${kind === "folders" ? " AND kind = 'user'" : ""}${filter}
           ORDER BY name_norm, uid LIMIT ?`,
        table,
        ...bindings,
        MAX_CHOICES,
      ).map(sealedRowOf);
      choices = (await this.#open(table, rows, dataKey)).map((row) => ({
        name: String(row.name),
        value: String(row.uid),
      }));
    }
    return { status: 200, body: { choices } };
  }

  /** The intents `integration` has written today (UTC) — what the daily cap counts. */
  #written(integration: Integration, now: number): number {
    const row = this.#sql(
      "SELECT count FROM intent_days WHERE integration = ? AND day = ?",
      integration,
      utcDay(now),
    )[0];
    return Number(row?.count ?? 0);
  }

  /**
   * `POST /c/intents` — **one intent into the inbox**: its shape (`400 bad_intent`), then the
   * token's scope for its kind (`403 scope` — a token that may not add learns nothing of how to
   * spell an add), then its payload (`400`), then the day's count (`429 intent_quota`). Sealed
   * before the transaction, which then decides again: the same store, the token still live, the
   * count still under the cap.
   */
  async #post(
    group: string,
    claims: Claims,
    scopes: Scope[],
    body: unknown,
    key: CryptoKey,
    storeId: string | null,
    now: number,
  ): Promise<Answer> {
    const shape = parseIntentShape(body);
    if (typeof shape === "string") return answer(400, shape, BAD_INTENT);
    if (!scopes.includes(scopeFor(shape.kind))) {
      return answer(403, `that token may not write ${shape.kind}`, SCOPE);
    }
    const payload = validatePayload(shape.kind, shape.payload);
    if (typeof payload === "string") return answer(400, payload, BAD_INTENT);
    const quota = () =>
      answer(
        429,
        `${claims.int} has written ${INTENTS_PER_DAY} intents today; try again tomorrow`,
        INTENT_QUOTA,
      );
    if (this.#written(claims.int, now) >= INTENTS_PER_DAY) return quota();

    const id = randomId();
    const sealed = await sealIntent(key, id, { payload, confirmedBy: shape.confirmedBy });
    return this.#storage.transactionSync(() => {
      if (!this.#exists() || this.#meta("store_id") !== storeId) return UNAUTHORIZED;
      this.#inbox();
      if (this.#live(claims) === null) return UNAUTHORIZED;
      if (this.#written(claims.int, now) >= INTENTS_PER_DAY) return quota();
      this.#tidy(now);
      const folderUid = typeof payload.folderUid === "string" ? payload.folderUid : null;
      this.#sql(
        `INSERT INTO intents (id, source, kind, state, created_at, name_norm, folder_uid, sealed)
           VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`,
        id,
        claims.int,
        shape.kind,
        now,
        hintName(payload),
        folderUid,
        bufferOf(sealed),
      );
      this.#sql(
        `INSERT INTO intent_days (integration, day, count) VALUES (?, ?, 1)
           ON CONFLICT (integration, day) DO UPDATE SET count = count + 1`,
        claims.int,
        utcDay(now),
      );
      const intent: Intent = {
        id,
        group,
        source: claims.int,
        kind: shape.kind,
        payload,
        createdAt: now,
        confirmedBy: shape.confirmedBy,
        state: "pending",
        reason: null,
      };
      return { status: 200, body: { intent } };
    });
  }

  /** `GET /c/intents/{id}` — one of the token's integration's own intents, in whatever state. */
  async #intent(claims: Claims, id: string, key: CryptoKey): Promise<Answer> {
    const row = this.#sql(
      `SELECT ${INTENT_COLUMNS} FROM intents WHERE id = ? AND source = ?`,
      id,
      claims.int,
    )[0];
    if (row === undefined) return answer(404, "no such intent of this integration's", NO_INTENT);
    return { status: 200, body: { intent: await this.#intentOf(key, intentRowOf(row)) } };
  }
}
