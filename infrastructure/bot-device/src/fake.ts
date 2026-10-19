/**
 * The suite's stand-ins: an engine that answers what a test tells it to, the alarm half of a
 * Durable Object's storage, a Discord signer, and `ctx.storage`'s SQL over Node's `node:sqlite`.
 * Nothing here is imported by anything the Worker deploys.
 */
import { DatabaseSync } from "node:sqlite";
import type { Alarms, Host } from "./device";
import { Proposals } from "./proposals";
import type { SqlStorageLike } from "./store";
import type { BotStatus, Choice, DeckSummary, Engine, Holding, Target } from "./types";
import type { TransferCard } from "@grimoire/ui/features/transfer/TransferCard";

export const PAIRED: BotStatus = {
  enrolled: true,
  deviceId: "d".repeat(32),
  paired: true,
  lastPullAt: 1_760_000_000_000,
  error: null,
};

/** An engine whose answers are fields a test sets, and which records every call. */
export class FakeEngine implements Engine {
  calls: string[] = [];
  state: BotStatus = PAIRED;
  holding: Holding | null = null;
  choices: Choice[] = [];
  deck: { deck: DeckSummary; cards: TransferCard[] } | null = null;
  enrolled = '{"ok":true,"deviceId":"dev","x25519":"x","ed25519":"e"}';
  advanced = '{"nextInMs":null,"purge":false,"did":"idle"}';
  broken = false;
  closed = false;
  folderChoices: Choice[] = [];
  /** What `target` answers: a folder, or a refusal's sentence. */
  targeted: Target | { refused: string } = { uid: "uid-added", path: "Added from Discord" };
  /** What `add` answers: a uid, or a refusal's sentence. Every add's JSON is kept. */
  added: string | { refused: string } = "row-uid";
  adds: unknown[] = [];

  #read(call: string, value: unknown): string {
    this.calls.push(call);
    return this.broken ? '{"err":"the database is gone"}' : JSON.stringify({ ok: value });
  }

  async enroll(invite: string, capability: string): Promise<string> {
    this.calls.push(`enroll ${invite} ${capability}`);
    return this.enrolled;
  }
  async advance(): Promise<string> {
    this.calls.push("advance");
    return this.advanced;
  }
  status(): string {
    return JSON.stringify(this.state);
  }
  collection_by_name(name: string): string {
    return this.#read(`collection ${name}`, this.holding);
  }
  wishlist_by_name(name: string): string {
    return this.#read(`wishlist ${name}`, this.holding);
  }
  names(kind: string, prefix: string, limit: number): string {
    return this.#read(`names ${kind} ${prefix} ${limit}`, this.choices);
  }
  decks(prefix: string): string {
    return this.#read(`decks ${prefix}`, []);
  }
  deck_cards(uid: string): string {
    return this.#read(`deck ${uid}`, this.deck);
  }
  folders(prefix: string, limit: number): string {
    return this.#read(`folders ${prefix} ${limit}`, this.folderChoices);
  }
  target(table: string, folder: string): string {
    this.calls.push(`target ${table} ${folder}`);
    if (this.broken) return '{"err":"the database is gone"}';
    const t = this.targeted;
    return JSON.stringify("refused" in t ? t : { ok: t });
  }
  add(add: string): string {
    this.calls.push("add");
    if (this.broken) return '{"err":"the database is gone"}';
    this.adds.push(JSON.parse(add));
    const a = this.added;
    return JSON.stringify(typeof a === "string" ? { ok: a } : a);
  }
  close(): void {
    this.closed = true;
  }
}

/** The alarm half of `ctx.storage`. */
export class FakeAlarms implements Alarms {
  at: number | null = null;
  sets: number[] = [];
  async getAlarm(): Promise<number | null> {
    return this.at;
  }
  async setAlarm(at: number): Promise<void> {
    this.at = at;
    this.sets.push(at);
  }
  async deleteAlarm(): Promise<void> {
    this.at = null;
  }
}

/** A Discord application's key pair, signing as Discord does: Ed25519 over timestamp + body. */
export async function signer() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const hex = (bytes: Uint8Array) =>
    Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return {
    publicKeyHex: hex(raw),
    async sign(timestamp: string, body: string): Promise<string> {
      const message = new TextEncoder().encode(timestamp + body);
      return hex(
        new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, message)),
      );
    },
  };
}

/** A proposal key for the suite: HKDF has nothing to do with it, a test only needs a key. */
export async function testKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new Uint8Array(32).fill(9), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

/** A request the device made, as the stubbed `fetch` saw it. */
export interface Asked {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

/**
 * A host over a fake engine, fake alarms and a clock a test sets — and an add's world: proposals
 * over a real SQLite, the deferred work collected (`settle()` awaits it), and one `fetch` that
 * answers Scryfall from `record.cards` (keyed by the path it is asked at) and Discord's webhook
 * with a 200, recording every request.
 */
export function host(engine: FakeEngine, publicKey: string, now = 1_760_000_060_000) {
  const alarms = new FakeAlarms();
  const storage = sqlStorage();
  const deferred: Promise<unknown>[] = [];
  const asked: Asked[] = [];
  const record = {
    purged: 0,
    opened: 0,
    now,
    /** Scryfall's answers, by request path and query (`/cards/c21/263`). */
    cards: {} as Record<string, unknown>,
    /** When set, Scryfall answers this status to everything. */
    scryfallStatus: null as number | null,
  };
  const fetcher = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    asked.push({
      url,
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      body: typeof init.body === "string" ? init.body : "",
    });
    const parsed = new URL(url);
    if (parsed.host === "scryfall.test") {
      if (record.scryfallStatus !== null)
        return new Response("{}", { status: record.scryfallStatus });
      const card = record.cards[parsed.pathname + parsed.search];
      return card === undefined
        ? new Response('{"object":"error"}', { status: 404 })
        : new Response(JSON.stringify(card), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const proposals = new Proposals(storage, testKey);
  const h: Host = {
    open: () => {
      record.opened += 1;
      return engine;
    },
    purge: async () => {
      record.purged += 1;
    },
    alarms,
    publicKey,
    now: () => record.now,
    proposals,
    defer: (work) => {
      deferred.push(work);
    },
    fetch: fetcher,
    scryfallUrl: "https://scryfall.test",
    discordApi: "https://discord.test/api/v10",
  };
  const settle = async () => {
    while (deferred.length > 0) await deferred.shift();
  };
  return { host: h, alarms, record, proposals, storage, asked, settle };
}

/** `ctx.storage`'s SQL and `transactionSync`, over a real SQLite in memory. */
export function sqlStorage(): SqlStorageLike & { db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  return {
    db,
    sql: {
      exec(query: string, ...bindings: unknown[]) {
        if (bindings.length === 0 && query.includes(";")) {
          db.exec(query);
          return { toArray: () => [] };
        }
        const params = bindings.map((b) => (b instanceof ArrayBuffer ? new Uint8Array(b) : b)) as (
          string | number | null | Uint8Array
        )[];
        const statement = db.prepare(query);
        const rows = /^\s*select/i.test(query)
          ? statement.all(...params)
          : (statement.run(...params), []);
        return { toArray: () => rows as Record<string, unknown>[] };
      },
    },
    transactionSync<T>(closure: () => T): T {
      db.exec("BEGIN");
      try {
        const out = closure();
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}
