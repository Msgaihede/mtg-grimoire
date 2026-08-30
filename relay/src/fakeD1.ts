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

export type Value = string | number | null;
export type Row = Record<string, Value>;
export type Tables = Record<string, Row[]>;

/**
 * Enough of the schema to make a duplicate insert fail the way SQLite makes it fail.
 *
 * ⚠️ **`group_devices` is here for a sharper reason than the other two.** The device cap's most
 * important assertion is that a device already counted does not consume a second slot — which
 * against a table that *cannot hold a duplicate row anyway* passes whatever `admitDevice` does.
 * With the key declared, dropping the `ON CONFLICT` clause raises a unique violation and dropping
 * this line makes every upsert throw by name (see `insertRow`), so both mutations are caught by
 * the fake rather than by luck.
 */
const PRIMARY_KEY: Record<string, string[]> = {
  entitlements: ["subject"],
  group_keys: ["group_id", "epoch"],
  group_devices: ["group_id", "device_id"],
};

/**
 * The partial unique indexes, as `column -> the table it is unique within`.
 *
 * **`entitlements_group` is `UNIQUE (group_id) WHERE group_id IS NOT NULL`, and modelling it is
 * not decoration.** It is the constraint that makes two subjects unable to hold one sync group —
 * a shared subscription wearing two names — and `handleClaim` reaches its 409 by *catching* the
 * failure rather than by asking a question first. Without it here, a claim on a group somebody
 * else already owns succeeds against this harness, and the test that says otherwise passes for
 * the wrong reason or not at all.
 */
const UNIQUE_NOT_NULL: Record<string, string[]> = {
  entitlements: ["group_id"],
};

/** SQLite's message, so a caller matching on the text sees what it would really see. */
function assertUnique(table: string, rows: Row[], candidate: Row, self: Row | null): void {
  for (const column of UNIQUE_NOT_NULL[table] ?? []) {
    const value = candidate[column] ?? null;
    if (value === null) continue;
    if (rows.some((row) => row !== self && (row[column] ?? null) === value)) {
      throw new Error(`fake sql: UNIQUE constraint failed: ${table}.${column}`);
    }
  }
}

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
  // `x IS NULL` / `x IS NOT NULL`. Not a comparison in SQLite's sense and not one here either:
  // `= NULL` is NULL and never true, which is exactly what `IS NULL` exists to get around, so
  // routing it through the operator table below would answer `false` for a null on both sides.
  if (peek(r) === "is") {
    r.at += 1;
    let negated = false;
    if (peek(r) === "not") {
      r.at += 1;
      negated = true;
    }
    want(r, "null");
    return negated ? left !== null : left === null;
  }
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

/**
 * One comparison, or a parenthesised condition.
 *
 * **A `(` here is a grouping and never a subquery**, which is the one ambiguity in this dialect
 * and it resolves cleanly: a subselect only ever appears in a *value* position, inside
 * `coalesce(…)`, where `primary` reaches it. A `(` at the start of a condition term is
 * `(group_id IS NULL OR group_id = ?)` and nothing else. Before this existed the token went to
 * `primary`, which read it as a subquery and threw `expected select, found group_id` — so the
 * binding `UPDATE` in `handleClaim` could not be tested at all.
 */
function term(r: Reader): boolean {
  if (peek(r) === "(") {
    r.at += 1;
    const inner = condition(r);
    want(r, ")");
    return inner;
  }
  return compare(r);
}

function conjunction(r: Reader): boolean {
  let ok = term(r);
  while (peek(r) === "and") {
    r.at += 1;
    // **`term(r) && ok` and never `ok && term(r)`.** Both sides have to run whatever the left one
    // said: a short-circuit would leave the right side's `?` unconsumed and every parameter after
    // it read one position out.
    ok = term(r) && ok;
  }
  return ok;
}

/** `OR` binds looser than `AND`, as in SQL. Same no-short-circuit rule, for the same reason. */
function condition(r: Reader): boolean {
  let ok = conjunction(r);
  while (peek(r) === "or") {
    r.at += 1;
    ok = conjunction(r) || ok;
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

/**
 * A literal in a `SET` list: a quoted string, `NULL`, or a number. Anything else throws by name
 * rather than being guessed at, which is this harness's rule everywhere — a statement it cannot
 * honour has to fail loudly here instead of quietly answering the wrong thing.
 */
function literal(source: string): Value {
  if (/^'[^']*'$/.test(source)) return source.slice(1, -1);
  if (/^null$/i.test(source)) return null;
  if (/^-?\d+$/.test(source)) return Number(source);
  throw new Error(`fake sql: ${source} is not a literal this harness knows`);
}

/** One row narrowed to a comma-separated column list, as `SELECT` and `RETURNING` both need. */
function project(row: Row, columnList: string): Row {
  const out: Row = {};
  for (const column of columnList.split(",").map((c) => c.trim())) out[column] = row[column] ?? null;
  return out;
}

/**
 * A `SET` list applied to a copy of a row: `column = ?` consuming parameters from `offset`
 * onwards, `column = <literal>` consuming none.
 *
 * **The copy is the point.** SQLite raises a constraint violation mid-statement and rolls the
 * whole statement back, so a fake that mutated first and checked afterwards would leave a
 * half-written row behind the exception and the next assertion in the test would be about a state
 * no database can be in. Both callers build the candidate here and only assign it once
 * `assertUnique` has had its say.
 */
function applyAssignments(row: Row, assignments: string[], params: Value[], offset: number): Row {
  const candidate: Row = { ...row };
  let bound = offset;
  for (const assignment of assignments) {
    const cut = assignment.indexOf("=");
    const column = assignment.slice(0, cut).trim();
    const source = assignment.slice(cut + 1).trim();
    if (source === "?") {
      candidate[column] = params[bound] ?? null;
      bound += 1;
    } else {
      candidate[column] = literal(source);
    }
  }
  return candidate;
}

/**
 * The `ON CONFLICT (…) DO UPDATE SET …` tail of an upsert, already split.
 *
 * `offset` is how many `?` the `VALUES` list ahead of it consumed, because D1 binds one flat list
 * across the whole statement and the SET list's own holes come after every value.
 */
interface Upsert {
  target: string[];
  assignments: string[];
  offset: number;
  params: Value[];
}

function insertRow(
  tables: Tables,
  table: string,
  row: Row,
  ignore: boolean,
  upsert?: Upsert,
): { results: Row[]; changes: number } {
  const rows = (tables[table] ??= []);
  const key = PRIMARY_KEY[table] ?? [];

  // **Checked before the conflict is looked for, because SQLite checks it before it knows there
  // is one.** `ON CONFLICT (a, b)` has to name a unique index or the statement is rejected at
  // prepare time — "does not match any PRIMARY KEY or UNIQUE constraint" — whatever the rows say.
  // Modelling that ordering is what makes deleting a `PRIMARY_KEY` entry a loud failure here
  // rather than a silent second row, which is the difference between the cap's headline test
  // proving something and proving nothing.
  if (upsert !== undefined) {
    const matches =
      upsert.target.length === key.length && upsert.target.every((c) => key.includes(c));
    if (!matches) {
      throw new Error(
        `fake sql: ON CONFLICT (${upsert.target.join(", ")}) does not match a unique ` +
          `constraint on ${table}`,
      );
    }
  }

  const clash =
    key.length > 0 ? rows.find((existing) => key.every((c) => existing[c] === row[c])) : undefined;
  if (clash !== undefined) {
    if (upsert !== undefined) {
      const candidate = applyAssignments(clash, upsert.assignments, upsert.params, upsert.offset);
      assertUnique(table, rows, candidate, clash);
      Object.assign(clash, candidate);
      return { results: [], changes: 1 };
    }
    if (ignore) return { results: [], changes: 0 };
    throw new Error(`fake sql: UNIQUE constraint failed: ${table}.${key.join(", ")}`);
  }
  assertUnique(table, rows, row, null);
  rows.push(row);
  return { results: [], changes: 1 };
}

/**
 * `INSERT … VALUES (…)`, with an optional `ON CONFLICT (…) DO UPDATE SET …` tail.
 *
 * **The upsert is a tail on this shape rather than a sixth statement shape** because everything
 * ahead of it — the column list, the values, the order the parameters bind in — is the insert
 * this branch already reads; the conflict clause only changes what happens when the row is
 * already there. It is assembled out of two pieces because the whole pattern on one line is
 * longer than this file's lines are allowed to be, and `String.raw` is what keeps the escapes
 * looking like the literal they came from.
 */
const INSERT_VALUES = new RegExp(
  String.raw`^INSERT (OR IGNORE )?INTO (\w+) \(([^)]+)\) VALUES \(([^)]+)\)` +
    String.raw`(?: ON CONFLICT \(([^)]+)\) DO UPDATE SET (.+))?$`,
  "i",
);

function execute(
  tables: Tables,
  sql: string,
  params: Value[],
): { results: Row[]; changes: number } {
  const text = sql.replace(/\s+/g, " ").trim();

  const insertValues = INSERT_VALUES.exec(text);
  if (insertValues) {
    const [, ignore, table, columnList, valueList, conflictList, setList] = insertValues;
    const columns = columnList.split(",").map((c) => c.trim());
    const terms = valueList.split(",").map((v) => v.trim());
    if (terms.some((term) => term !== "?")) throw new Error(`fake sql: only ? in VALUES`);
    const row: Row = {};
    columns.forEach((column, index) => {
      row[column] = params[index] ?? null;
    });
    const upsert =
      conflictList === undefined || setList === undefined
        ? undefined
        : {
            target: conflictList.split(",").map((c) => c.trim()),
            assignments: setList.split(",").map((a) => a.trim()),
            offset: terms.length,
            params,
          };
    return insertRow(tables, table, row, ignore !== undefined, upsert);
  }

  // `OR IGNORE` is optional here as it is on the VALUES form above. `seedGroup` needs both
  // halves at once: the `WHERE` refuses an epoch behind the group, and the `OR IGNORE` swallows
  // the duplicate when a re-claim arrives at the epoch the group is already on.
  const insertSelect =
    /^INSERT (OR IGNORE )?INTO (\w+) \(([^)]+)\) SELECT (.+?) WHERE (.+)$/i.exec(text);
  if (insertSelect) {
    const [, selectIgnore, table, columnList, selectList, where] = insertSelect;
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
    return insertRow(tables, table, row, selectIgnore !== undefined);
  }

  // **`RETURNING` is honoured, and it has to be.** `handleClaim`'s single-use guard is one
  // `DELETE … RETURNING subject`, which is what makes the code single-use under two racing
  // requests. Without this branch the clause fell into the `WHERE` and the statement answered no
  // rows *silently*, so every `handleClaim` against this fake stopped at its 401 and the whole
  // route was untestable — worse than throwing, because it looked like a working refusal.
  const remove = /^DELETE FROM (\w+) WHERE (.+?)(?: RETURNING (.+))?$/i.exec(text);
  if (remove) {
    const [, table, where, returning] = remove;
    const rows = tables[table] ?? [];
    const doomed = new Set(matching(where, rows, params, 0, tables));
    tables[table] = rows.filter((row) => !doomed.has(row));
    const results = returning === undefined ? [] : [...doomed].map((row) => project(row, returning));
    return { results, changes: doomed.size };
  }

  const update = /^UPDATE (\w+) SET (.+?) WHERE (.+)$/i.exec(text);
  if (update) {
    const [, table, setList, where] = update;
    const assignments = setList.split(",").map((a) => a.trim());
    // ⚠️ **The offset is the number of `?` in the SET list, not the number of assignments.**
    // A literal consumes no parameter, so `SET status = 'dead', grace_until = NULL, checked_at = ?`
    // binds one — and counting three shifted every `?` in the `WHERE` by two. That did not throw:
    // the mismatched `WHERE` simply matched no rows, the per-row loop never ran, and the statement
    // answered `changes: 0`. `revoke` is exactly that shape, so a test asserting a revocation
    // passed against a fake that had revoked nothing.
    const holes = assignments.filter((a) => a.slice(a.indexOf("=") + 1).trim() === "?").length;
    const matched = matching(where, tables[table] ?? [], params, holes, tables);
    const all = tables[table] ?? [];
    for (const row of matched) {
      // Built beside the row and only then applied — see `applyAssignments`, which the upsert
      // path shares for the same reason.
      const candidate = applyAssignments(row, assignments, params, 0);
      assertUnique(table, all, candidate, row);
      Object.assign(row, candidate);
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
    group_devices: [],
  };
  return fakeEnvOver(tables);
}

/**
 * The same tables `fakeEnv` builds, handed back so a caller can seed a row this harness does not
 * know about — `claim_codes`, say — and read what a handler wrote.
 *
 * **`bound` is the difference that matters.** `fakeEnv` files every entitlement already bound to
 * its group, which is the state `/token` is asked about; a *claim* is the moment the binding is
 * made, so its `UPDATE` has to exercise the `group_id IS NULL` arm of
 * `WHERE … AND (group_id IS NULL OR group_id = ?)`. Passing `bound: false` is what lets a test
 * watch a first claim rather than a re-claim.
 */
export function fakeTables(options: { groups: string[]; bound?: boolean }): Tables {
  const bound = options.bound ?? true;
  return {
    entitlements: options.groups.map((group, index) => ({
      subject: `sub-${index}`,
      source: "patreon",
      external_id: `ext-${index}`,
      status: "active",
      grace_until: null,
      group_id: bound ? group : null,
      refresh_secret: bound ? `secret-${index}` : null,
      patreon_refresh: null,
      created_at: 0,
      checked_at: 0,
      group_epoch: null,
      group_auth: null,
    })),
    group_keys: [],
    // Seeded empty rather than left to `insertRow`'s `??= []`, so a test can assert on the table
    // *before* anything has been admitted to it — "the group is full" and "the group does not
    // exist yet" are the two states the cap has to tell apart, and a table that springs into
    // being on first write cannot express the second.
    group_devices: [],
    claim_codes: [],
  };
}

/** An `Env` over tables the caller already holds a reference to, so it can assert on them. */
export function fakeEnvOver(tables: Tables): Env {
  return { DB: fakeDatabase(tables) } as unknown as Env;
}

