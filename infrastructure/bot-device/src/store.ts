/**
 * **The engine's page store**: the two tables its SQLite VFS keeps its database files in, on this
 * Durable Object's own synchronous SQL storage (`crates/grimoire-bot/src/vfs.rs` has the design).
 *
 * ```sql
 * files(name TEXT PRIMARY KEY, size INTEGER NOT NULL)
 * pages(file TEXT NOT NULL, no INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (file, no))
 * ```
 *
 * A page is 4 096 bytes of a database file **sealed** — `nonce ‖ ciphertext ‖ tag` under a key
 * derived from `BOT_KEK` — so nothing written here is readable without the secret. `name` is the
 * file's name within the object (`user.db`, `corpus.db`); `size` is its length in the clear, the
 * one fact about a file the seal does not cover.
 *
 * **Every method is synchronous**, which is the whole reason a Durable Object can host the VFS:
 * the engine calls them from inside SQLite's `xRead` and `xSync`. **`commit` is one
 * `transactionSync`**: SQLite calls it once per transaction, at its sync, with every page that
 * transaction wrote — so storage holds one committed state or the next, never half of one.
 *
 * **`revoke()` is for `unlink`**: once it is called every method throws, so an operation still in
 * flight in the engine when `deleteAll()` runs writes nothing back.
 */
/** The four synchronous methods the engine's VFS calls (`crates/grimoire-bot/src/glue.rs`'s
 *  `JsStore`). */
export interface PageStoreJs {
  size(file: string): number | null;
  read(file: string, no: number): Uint8Array | null;
  commit(
    file: string,
    size: number,
    nos: number[],
    pages: Uint8Array[],
    truncateFrom: number | null,
  ): void;
  remove(file: string): void;
}

/** The part of `ctx.storage` this uses — `DurableObjectStorage`'s, narrowed for a test's fake. */
export interface SqlStorageLike {
  sql: { exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] } };
  transactionSync<T>(closure: () => T): T;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS files (name TEXT PRIMARY KEY, size INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS pages (
    file TEXT NOT NULL, no INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (file, no)
  ) WITHOUT ROWID;
`;

/** What a revoked store says. */
export const REVOKED = "the bot's storage was deleted";

export class SqlPageStore implements PageStoreJs {
  #storage: SqlStorageLike;
  #revoked = false;

  constructor(storage: SqlStorageLike) {
    this.#storage = storage;
    storage.sql.exec(SCHEMA);
  }

  #sql(query: string, ...bindings: unknown[]): Record<string, unknown>[] {
    if (this.#revoked) throw new Error(REVOKED);
    return this.#storage.sql.exec(query, ...bindings).toArray();
  }

  size(file: string): number | null {
    const row = this.#sql("SELECT size FROM files WHERE name = ?", file)[0];
    return row === undefined ? null : Number(row.size);
  }

  read(file: string, no: number): Uint8Array | null {
    const row = this.#sql("SELECT data FROM pages WHERE file = ? AND no = ?", file, no)[0];
    if (row === undefined) return null;
    const data = row.data;
    return data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data as Uint8Array);
  }

  commit(
    file: string,
    size: number,
    nos: number[],
    pages: Uint8Array[],
    truncateFrom: number | null,
  ): void {
    if (this.#revoked) throw new Error(REVOKED);
    this.#storage.transactionSync(() => {
      this.#sql(
        "INSERT INTO files (name, size) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET size = excluded.size",
        file,
        size,
      );
      if (truncateFrom !== null) {
        this.#sql("DELETE FROM pages WHERE file = ? AND no >= ?", file, truncateFrom);
      }
      nos.forEach((no, at) => {
        const page = pages[at];
        this.#sql(
          "INSERT OR REPLACE INTO pages (file, no, data) VALUES (?, ?, ?)",
          file,
          no,
          page.buffer.slice(page.byteOffset, page.byteOffset + page.byteLength),
        );
      });
    });
  }

  remove(file: string): void {
    if (this.#revoked) throw new Error(REVOKED);
    this.#storage.transactionSync(() => {
      this.#sql("DELETE FROM pages WHERE file = ?", file);
      this.#sql("DELETE FROM files WHERE name = ?", file);
    });
  }

  /** Refuse every call from now on — before `deleteAll()`. */
  revoke(): void {
    this.#revoked = true;
  }
}
