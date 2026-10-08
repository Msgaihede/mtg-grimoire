/**
 * Node's own SQLite, declared for this program alone — as much of it as `fakeState.ts` uses.
 *
 * `infrastructure/relay/tsconfig.json` pins `types` to `@cloudflare/workers-types`, so `@types/node` is
 * deliberately not in reach (the relay runs in workerd, and Node's globals must not type-check
 * there). The tests are run by the root vitest, in Node, which does have the module; this is the
 * declaration that lets one of them say so without bringing the rest of Node's types with it —
 * `raw.d.ts`'s arrangement, for a second import.
 */
declare module "node:sqlite" {
  type Value = string | number | bigint | null | Uint8Array;

  interface StatementSync {
    /** Run the statement and answer every row it produced — none, for one that produces none. */
    all(...bindings: Value[]): Record<string, Value>[];
    /** Run the statement for what it does; whatever rows it produces are not answered. */
    run(...bindings: Value[]): unknown;
    /** The rows, one at a time: the statement steps when a row is asked for. */
    iterate(...bindings: Value[]): Iterable<Record<string, Value>>;
    /** The columns the statement answers — none, for one that only writes. */
    columns(): unknown[];
  }

  export class DatabaseSync {
    constructor(path: string);
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
