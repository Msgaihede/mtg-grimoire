import { inflate, MAX_INFLATED_BYTES } from "./body";
import {
  clearColumns,
  enabledNames,
  isMarketplace,
  parseFields,
  validateDocument,
  type Document,
  type FieldName,
  type GroupSettings,
  type IntegrationFields,
  type Table,
} from "./projection";
import {
  importKek,
  kekFingerprint,
  macKey,
  newDataKey,
  rewrap,
  rowKey,
  rowMac,
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
 * ```
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
 * row's generation and its MAC; every row whole is `sealed` (`seal.ts`). There is no index beyond the primary key yet, deliberately: a
 * Durable Object's SQLite bills each row written, an index's row included, and nothing queries
 * these columns until the intents and integrations of the issue's PR 3 and 4.
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
}

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
      for (const statement of SCHEMA) this.#sql(statement);
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
}
