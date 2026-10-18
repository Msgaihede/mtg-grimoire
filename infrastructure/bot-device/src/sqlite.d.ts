/**
 * The few names of Node's `node:sqlite` that `fake.ts` stands a Durable Object's SQL storage up with, declared for this
 * program alone: `infrastructure/bot-device/tsconfig.json` pins `types` to
 * `@cloudflare/workers-types`, so Node's own declarations are deliberately out of reach. Nothing
 * the Worker deploys imports it — the suite runs under Node, and `scripts/d1-migrations.test.ts`
 * opens the same module for the same reason.
 */
declare module "node:sqlite" {
  type SQLValue = string | number | bigint | null | Uint8Array;
  interface StatementSync {
    all(...params: SQLValue[]): Record<string, SQLValue>[];
    get(...params: SQLValue[]): Record<string, SQLValue> | undefined;
    run(...params: SQLValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  }
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
