/**
 * **An add waiting for its Confirm** (the Discord spec, §14.4): what `/collection add` and
 * `/wishlist add` resolved, kept until the reader presses Confirm or Cancel, or for
 * {@link PROPOSAL_TTL_MS}.
 *
 * ```sql
 * proposals(id TEXT PRIMARY KEY, discord_user_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
 *           sealed BLOB NOT NULL)
 * ```
 *
 * **In this object's own storage, apart from the engine's database**: a proposal is nothing the
 * group should ever see, and writing it into `user.db` would be a row the engine would have to be
 * taught to keep out of sync. The table sits beside the page store's two (`store.ts`) and goes
 * with them in `deleteAll()`.
 *
 * **Sealed, as every page is**: the add and its summary (a card, a folder's name) are AES-GCM
 * under a key HKDF derives from `BOT_KEK` and the object's id, with the three clear columns as the
 * associated data — so a copy of the storage alone says only that somebody had something pending
 * until a time. The id is 16 random bytes, base64url; the user id is Discord's, which the front
 * already has.
 *
 * **Expired proposals are deleted opportunistically**: every read purges what is past its time
 * first, so a table no reader comes back to holds at most what one reader asked for in fifteen
 * minutes, until the next press or command.
 */
import type { SqlStorageLike } from "./store";

/** How long a proposal waits for its Confirm: fifteen minutes, Discord's own life of the
 *  interaction token the proposal's message was written with. */
export const PROPOSAL_TTL_MS = 15 * 60 * 1000;

/** A proposal's id: 16 random bytes, base64url without padding — 22 characters. */
export const PROPOSAL_ID = /^[A-Za-z0-9_-]{22}$/;

/** What a proposal holds. `add` is `integration::add::Add` as JSON, which the engine takes back
 *  as it is; `summary` is the sentence's middle (`2× Lightning Bolt — … — to Added from Discord`). */
export interface Proposal {
  id: string;
  discordUserId: string;
  add: unknown;
  summary: string;
  expiresAt: number;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS proposals (
    id TEXT PRIMARY KEY, discord_user_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
    sealed BLOB NOT NULL
  );`;

const INFO = new TextEncoder().encode("mtg-grimoire/bot-proposal/v1");

function base64url(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Base64url (padded or not) as bytes, or `null`. */
export function fromBase64url(text: string): Uint8Array | null {
  const plain = text.trim().replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*$/.test(plain)) return null;
  try {
    const binary = atob(plain + "=".repeat((4 - (plain.length % 4)) % 4));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

/** A fresh proposal id. */
export function proposalId(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * The proposals' key: HKDF-SHA-256 over `BOT_KEK`'s 32 bytes, salted with the object's id.
 * Throws a sentence when the secret is not 32 bytes of base64url — the engine would not have
 * opened either, so no proposal is ever made under such a key.
 */
export async function proposalKey(kek: string, object: string): Promise<CryptoKey> {
  const bytes = fromBase64url(kek);
  if (bytes?.length !== 32) throw new Error("BOT_KEK is not 32 bytes of base64url");
  const base = await crypto.subtle.importKey("raw", bytes, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode(object), info: INFO },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function associated(id: string, user: string, expiresAt: number): Uint8Array {
  return new TextEncoder().encode(`${id}\u0000${user}\u0000${expiresAt}`);
}

function bytesOf(value: unknown): Uint8Array {
  return value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value as Uint8Array);
}

export class Proposals {
  #storage: SqlStorageLike;
  #key: () => Promise<CryptoKey>;
  #cached: Promise<CryptoKey> | null = null;

  /** `key` is asked once, on the first seal or open. */
  constructor(storage: SqlStorageLike, key: () => Promise<CryptoKey>) {
    this.#storage = storage;
    this.#key = key;
  }

  /** The table is made on every use: `deleteAll()` takes it with everything else. */
  #sql(query: string, ...bindings: unknown[]): Record<string, unknown>[] {
    this.#storage.sql.exec(SCHEMA);
    return this.#storage.sql.exec(query, ...bindings).toArray();
  }

  #keyed(): Promise<CryptoKey> {
    this.#cached ??= this.#key();
    return this.#cached;
  }

  /** Delete every proposal past its time. */
  purge(now: number): void {
    this.#sql("DELETE FROM proposals WHERE expires_at <= ?", now);
  }

  async put(proposal: Proposal): Promise<void> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(
      JSON.stringify({ add: proposal.add, summary: proposal.summary }),
    );
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: associated(proposal.id, proposal.discordUserId, proposal.expiresAt),
        },
        await this.#keyed(),
        plain,
      ),
    );
    const blob = new Uint8Array(iv.length + sealed.length);
    blob.set(iv, 0);
    blob.set(sealed, iv.length);
    this.#sql(
      "INSERT OR REPLACE INTO proposals (id, discord_user_id, expires_at, sealed) VALUES (?, ?, ?, ?)",
      proposal.id,
      proposal.discordUserId,
      proposal.expiresAt,
      blob.buffer,
    );
  }

  /** The proposal `id`, unless it is past its time (or never was). Purges first. A row that does
   *  not open under this key is no proposal, and is deleted. */
  async get(id: string, now: number): Promise<Proposal | null> {
    this.purge(now);
    if (!PROPOSAL_ID.test(id)) return null;
    const row = this.#sql(
      "SELECT discord_user_id, expires_at, sealed FROM proposals WHERE id = ?",
      id,
    )[0];
    if (row === undefined) return null;
    const discordUserId = String(row.discord_user_id);
    const expiresAt = Number(row.expires_at);
    const blob = bytesOf(row.sealed);
    try {
      const plain = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: blob.slice(0, 12),
          additionalData: associated(id, discordUserId, expiresAt),
        },
        await this.#keyed(),
        blob.slice(12),
      );
      const { add, summary } = JSON.parse(new TextDecoder().decode(plain)) as {
        add: unknown;
        summary: string;
      };
      return { id, discordUserId, add, summary, expiresAt };
    } catch {
      this.delete(id);
      return null;
    }
  }

  delete(id: string): void {
    this.#sql("DELETE FROM proposals WHERE id = ?", id);
  }

  /** How many are kept — for a test. */
  count(): number {
    return Number(this.#sql("SELECT count(*) AS n FROM proposals")[0]?.n ?? 0);
  }
}
