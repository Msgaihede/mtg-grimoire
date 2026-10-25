/**
 * What the suite reads that `@cloudflare/workers-types` does not declare, for this program alone:
 * `infrastructure/integrations-worker/tsconfig.json` pins `types` to the Workers' globals, so
 * Node's and Vite's own declarations are deliberately out of reach. Nothing the Worker deploys
 * reads any of it — `src/` imports none of these modules.
 */

/**
 * The few names of Node's `node:sqlite` the suite stands a Durable Object's SQL storage and the
 * relay's D1 up with — the Discord branch's `bot-device/src/sqlite.d.ts`, and
 * `scripts/d1-migrations.test.ts` opens the same module for the same reason.
 */
declare module "node:sqlite" {
  export type SQLValue = string | number | bigint | null | Uint8Array;
  export interface StatementSync {
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

/** Vite's text import — `infrastructure/relay/src/raw.d.ts`'s arrangement. */
declare module "*?raw" {
  const text: string;
  export default text;
}

interface ImportMeta {
  /** Every file a pattern matches, as text, by its path from the repository root. */
  glob(
    pattern: string | string[],
    options: { query: "?raw"; import: "default"; eager: true; exhaustive?: true },
  ): Record<string, string>;
}

/** The measurement's switch (`measure.test.ts`): the suite runs under Node, which has it. */
declare const process: { env: Record<string, string | undefined> };
