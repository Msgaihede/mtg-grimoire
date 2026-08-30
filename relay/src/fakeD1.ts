import type { Env } from "./index";

/**
 * A fake `env.DB` that **executes** the SQL rather than recognising it — the harness every
 * D1-backed test in this directory shares.
 *
 * **It lives beside the code rather than inside one test file because three suites need it**:
 * `groupauth.test.ts` wrote it, and `rotate.test.ts` and `claim.test.ts` read the same tables.
 * A test file cannot import another test file without re-running its `describe`s, so the choice
 * was one shared module or three drifting copies of a SQL evaluator. It is named `fakeD1.ts`
 * rather than `fakeD1.test.ts` so vitest's `relay/src/**\/*.test.ts` glob does not collect it as
 * a suite, and nothing in the Worker's entry graph imports it, so it is not in the deployed
 * bundle.
 *
 * **That distinction is the whole reason this harness exists, and it is why it is not four
 * lines.** Every decision `groupauth.ts` makes is spelled in SQL: the monotonic guard is a
 * `WHERE ? > coalesce(…)` and the eight-epoch window is a `WHERE epoch <= ? - ?`. A fake that
 * matched statements by shape and answered from JavaScript would give the same answer whatever
 * those clauses said — the guard would be untested, and changing its `>` to a `>=` would leave
 * every test in this file green while a removed device could re-register the auth it remembers
 * and walk back into the group that evicted it. So the fake tokenises the clause and evaluates
 * it, and the mutation is caught by the comparison actually being run.
 *
 * The dialect it covers is exactly the one this module writes and no more: five statement
 * shapes, `AND`, arithmetic, `coalesce`, and a `max()` subquery. Anything else throws by name,
 * so a later statement that this harness cannot honour fails loudly here rather than quietly
 * passing.
 *
 * `@cloudflare/vitest-pool-workers` would run real D1 and is ruled out for the tree's reason
 * (`relay/README.md`): it drags wrangler and workerd into a suite pinned to vitest 4.1.10.
 * `node:sqlite` would too, and is ruled out for a sharper one — it is behind
 * `--experimental-sqlite` on the Node 22 CI runs on, so it would pass here and fail there.
 */

// ---------------------------------------------------------------------------------------
// A very small SQL engine
// ---------------------------------------------------------------------------------------

type Value = string | number | null;
type Row = Record<string, Value>;
type Tables = Record<string, Row[]>;

/** Enough of the schema to make a duplicate insert fail the way SQLite makes it fail. */
const PRIMARY_KEY: Record<string, string[]> = {
  entitlements: ["subject"],
  group_keys: ["group_id", "epoch"],
};

/**
 * Where a statement has got to: the tokens of one clause, the parameters it is consuming, and
 * the row a bare column name refers to.
 *
 * `bound` moves left to right through `params` as the text is read, which is the same order D1
 * binds them in. It has to be a cursor and not an index into a pre-split list, because the
 * monotonic guard's last `?` is inside a subquery.
 */
interface Reader {
  tokens: string[];
  at: number;
  params: Value[];
  bound: number;
  tables: Tables;
  row: Row;
}

function tokenize(text: string): string[] {
  return text.match(/>=|<=|<>|[<>=]|[()?,+-]|\d+|[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
}

function peek(r: Reader): string {
  return (r.tokens[r.at] ?? "").toLowerCase();
}

function take(r: Reader): string {
  const token = r.tokens[r.at] ?? "";
  r.at += 1;
  return token;
}

function want(r: Reader, word: string): void {
  const got = take(r);
  if (got.toLowerCase() !== word) {
    throw new Error(`fake sql: expected ${word}, found ${got || "end of clause"}`);
  }
}

/** SQLite's ordering for the two column types this schema has. */
function order(a: Value, b: Value): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const left = String(a);
  const right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** `(SELECT max(col) FROM table WHERE …)`, with the opening paren already taken. */
function subselect(r: Reader): Value {
  want(r, "select");
  want(r, "max");
  want(r, "(");
  const column = take(r);
  want(r, ")");
  want(r, "from");
  const table = take(r);
  want(r, "where");

  const rows = r.tables[table] ?? [];
  const outerRow = r.row;
  const start = r.at;
  const startBound = r.bound;
  let best: Value = null;
  // **At least one pass, even over an empty table.** The condition's tokens and its bound
  // parameters have to be consumed exactly once whatever the rows say, or every `?` after this
  // point in the statement reads the wrong value — which for the monotonic guard would mean the
  // group id landing where the epoch belongs.
  for (const row of rows.length > 0 ? rows : [{}]) {
    r.at = start;
    r.bound = startBound;
    r.row = row;
    const matched = condition(r);
    if (matched && rows.length > 0) {
      const value = row[column] ?? null;
      if (value !== null && (best === null || order(value, best) > 0)) best = value;
    }
  }
  r.row = outerRow;
  want(r, ")");
  return best;
}

function primary(r: Reader): Value {
  const token = take(r);
  const word = token.toLowerCase();
  if (word === "?") {
    const value = r.params[r.bound] ?? null;
    r.bound += 1;
    return value;
  }
  if (word === "-") {
    const value = primary(r);
    return typeof value === "number" ? -value : null;
  }
  if (/^\d+$/.test(word)) return Number(word);
  if (word === "coalesce") {
    want(r, "(");
    const first = sum(r);
    want(r, ",");
    const second = sum(r);
    want(r, ")");
    return first ?? second;
  }
  if (word === "(") return subselect(r);
  return r.row[token] ?? null;
}

function sum(r: Reader): Value {
  let value = primary(r);
  for (;;) {
    const op = peek(r);
    if (op !== "+" && op !== "-") return value;
    r.at += 1;
    const rhs = primary(r);
    value =
      typeof value === "number" && typeof rhs === "number"
        ? op === "+"
          ? value + rhs
          : value - rhs
        : null;
  }
}

const COMPARISONS = new Set(["=", ">", ">=", "<", "<=", "<>"]);

function compare(r: Reader): boolean {
  const left = sum(r);
  const op = take(r);
  if (!COMPARISONS.has(op)) throw new Error(`fake sql: ${op} is not a comparison`);
  const right = sum(r);
  // SQLite: a comparison against NULL is NULL, which is never true.
  if (left === null || right === null) return false;
  const relation = order(left, right);
  switch (op) {
    case "=":
      return relation === 0;
    case "<>":
      return relation !== 0;
    case ">":
      return relation > 0;
    case ">=":
      return relation >= 0;
    case "<":
      return relation < 0;
    default:
      return relation <= 0;
  }
}

function condition(r: Reader): boolean {
  let ok = compare(r);
  while (peek(r) === "and") {
    r.at += 1;
    // **`compare(r) && ok` and never `ok && compare(r)`.** Both sides have to run whatever the
    // left one said: a short-circuit would leave the right side's `?` unconsumed and every
    // parameter after it read one position out.
    ok = compare(r) && ok;
  }
  return ok;
}

function matching(
  where: string,
  rows: Row[],
  params: Value[],
  offset: number,
  tables: Tables,
): Row[] {
  const tokens = tokenize(where);
  return rows.filter((row) => condition({ tokens, at: 0, params, bound: offset, tables, row }));
}

function insertRow(
  tables: Tables,
  table: string,
  row: Row,
  ignore: boolean,
): { results: Row[]; changes: number } {
  const rows = (tables[table] ??= []);
  const key = PRIMARY_KEY[table] ?? [];
  if (key.length > 0 && rows.some((existing) => key.every((c) => existing[c] === row[c]))) {
    if (ignore) return { results: [], changes: 0 };
    throw new Error(`fake sql: UNIQUE constraint failed: ${table}.${key.join(", ")}`);
  }
  rows.push(row);
  return { results: [], changes: 1 };
}

function execute(
  tables: Tables,
  sql: string,
  params: Value[],
): { results: Row[]; changes: number } {
  const text = sql.replace(/\s+/g, " ").trim();

  const insertValues = /^INSERT (OR IGNORE )?INTO (\w+) \(([^)]+)\) VALUES \(([^)]+)\)$/i.exec(
    text,
  );
  if (insertValues) {
    const [, ignore, table, columnList, valueList] = insertValues;
    const columns = columnList.split(",").map((c) => c.trim());
    const terms = valueList.split(",").map((v) => v.trim());
    if (terms.some((term) => term !== "?")) throw new Error(`fake sql: only ? in VALUES`);
    const row: Row = {};
    columns.forEach((column, index) => {
      row[column] = params[index] ?? null;
    });
    return insertRow(tables, table, row, ignore !== undefined);
  }

  const insertSelect = /^INSERT INTO (\w+) \(([^)]+)\) SELECT (.+?) WHERE (.+)$/i.exec(text);
  if (insertSelect) {
    const [, table, columnList, selectList, where] = insertSelect;
    const columns = columnList.split(",").map((c) => c.trim());
    const terms = selectList.split(",").map((v) => v.trim());
    if (terms.some((term) => term !== "?")) throw new Error(`fake sql: only ? in SELECT`);
    const row: Row = {};
    columns.forEach((column, index) => {
      row[column] = params[index] ?? null;
    });
    // No FROM, so the condition is asked once against a row with no columns — every term in it
    // is either a parameter or a subquery.
    if (matching(where, [{}], params, terms.length, tables).length === 0) {
      return { results: [], changes: 0 };
    }
    return insertRow(tables, table, row, false);
  }

  const remove = /^DELETE FROM (\w+) WHERE (.+)$/i.exec(text);
  if (remove) {
    const [, table, where] = remove;
    const rows = tables[table] ?? [];
    const doomed = new Set(matching(where, rows, params, 0, tables));
    tables[table] = rows.filter((row) => !doomed.has(row));
    return { results: [], changes: doomed.size };
  }

  const update = /^UPDATE (\w+) SET (.+?) WHERE (.+)$/i.exec(text);
  if (update) {
    const [, table, setList, where] = update;
    const assignments = setList.split(",").map((a) => a.trim());
    const matched = matching(where, tables[table] ?? [], params, assignments.length, tables);
    for (const row of matched) {
      assignments.forEach((assignment, index) => {
        const [column, term] = assignment.split("=").map((part) => part.trim());
        if (term !== "?") throw new Error(`fake sql: only ? in SET`);
        row[column] = params[index] ?? null;
      });
    }
    return { results: [], changes: matched.length };
  }

  const select = /^SELECT (.+?) FROM (\w+)(.*)$/i.exec(text);
  if (select) {
    const [, columnList, table, tailText] = select;
    let tail = tailText;
    let limit = Number.POSITIVE_INFINITY;
    const limitClause = /\sLIMIT (\d+)$/i.exec(tail);
    if (limitClause) {
      limit = Number(limitClause[1]);
      tail = tail.slice(0, limitClause.index);
    }
    let orderColumn = "";
    let descending = false;
    const orderClause = /\sORDER BY (\w+)( DESC| ASC)?$/i.exec(tail);
    if (orderClause) {
      orderColumn = orderClause[1];
      descending = /desc/i.test(orderClause[2] ?? "");
      tail = tail.slice(0, orderClause.index);
    }
    const whereClause = /^\s*WHERE (.+)$/i.exec(tail);

    const all = tables[table] ?? [];
    let rows = whereClause ? matching(whereClause[1], all, params, 0, tables) : [...all];
    if (orderColumn !== "") {
      rows = [...rows].sort(
        (a, b) => (descending ? -1 : 1) * order(a[orderColumn] ?? null, b[orderColumn] ?? null),
      );
    }
    const columns = columnList.split(",").map((c) => c.trim());
    const results = rows.slice(0, limit).map((row) => {
      const projected: Row = {};
      for (const column of columns) projected[column] = row[column] ?? null;
      return projected;
    });
    return { results, changes: 0 };
  }

  throw new Error(`fake sql: this harness does not execute ${text}`);
}

// ---------------------------------------------------------------------------------------
// The Env it hangs on
// ---------------------------------------------------------------------------------------

function fakeDatabase(tables: Tables): unknown {
  const statement = (sql: string, params: Value[]) => ({
    bind: (...values: Value[]) => statement(sql, values),
    first: <T>() => Promise.resolve((execute(tables, sql, params).results[0] ?? null) as T | null),
    all: <T>() =>
      Promise.resolve({
        success: true,
        meta: {},
        results: execute(tables, sql, params).results as T[],
      }),
    run: () =>
      Promise.resolve({ success: true, meta: { changes: execute(tables, sql, params).changes } }),
  });
  return {
    prepare: (sql: string) => statement(sql, []),
    batch: (statements: { run: () => Promise<unknown> }[]) =>
      Promise.all(statements.map((one) => one.run())),
  };
}

/**
 * An `Env` whose `DB` is the fake above, with an entitlement row already bound to each named
 * group.
 *
 * **The binding is a precondition rather than scenery.** `authIsCurrent` reads
 * `entitlements.group_auth`, and `seedGroup` and `recordRotation` mirror onto that row — so a
 * group with no entitlement is a group whose current auth is written nowhere, which is exactly
 * the state spec §2.4 relies on: no membership, no removal. Passing a group in here is saying
 * "somebody connected a Patreon membership and claimed this group".
 */
export function fakeEnv(...groups: string[]): Env {
  const tables: Tables = {
    entitlements: groups.map((group, index) => ({
      subject: `sub-${index}`,
      source: "patreon",
      external_id: `ext-${index}`,
      status: "active",
      grace_until: null,
      group_id: group,
      refresh_secret: `secret-${index}`,
      patreon_refresh: null,
      created_at: 0,
      checked_at: 0,
      group_epoch: null,
      group_auth: null,
    })),
    group_keys: [],
  };
  return { DB: fakeDatabase(tables) } as unknown as Env;
}

