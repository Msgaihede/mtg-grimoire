import { DatabaseSync } from "node:sqlite";
import { vi } from "vitest";

/**
 * A stand-in for the `DurableObjectState` a `Group` is constructed over, and for the three
 * globals of workerd's that `group.ts` names — the one harness every test that builds the real
 * class shares.
 *
 * **It was `ticket.test.ts`'s own**, with SQL that was scenery: every `exec` answered one row
 * that satisfied the constructor, because nothing there asserted on a row. Paging (step 6.5b)
 * needs the opposite — `pull`, `ack` and `push` are *decided* in SQL, a window by `seq`, a filter
 * on the sender, an `EXISTS` — so the same stand-in can now be asked to put **SQLite itself**
 * behind `storage.sql`, and is named `fakeState.ts` rather than `*.test.ts` so two suites can
 * import it without one re-running the other's `describe`s (`fakeD1.ts`'s arrangement).
 *
 * **Why SQLite and not a recogniser of statements.** A fake that matched `pull`'s queries by
 * shape and answered from JavaScript would answer the same whatever their `WHERE` said: the
 * cursor that must pass a caller's own trailing rows, `more` being exact at a page's edge and
 * the unpaged answer's order are each one clause, and each would be untested. `fakeD1.ts` makes
 * the same argument and then writes its own evaluator, for a reason that no longer holds here:
 * it ruled `node:sqlite` out as behind a flag on the Node CI ran. CI runs the Node `.nvmrc`
 * names, 24, and `package.json` asks for 22.18 or later — both of which have the module with no
 * flag. A Durable Object's storage *is* SQLite, so this is the nearest thing to it that runs
 * under vitest: the dialect is the same one, and what differs — billing, the 2 MB row cap, a
 * cursor that is lazy — is none of what these tests assert.
 *
 * **It also keeps what was asked**, statement by statement, with how many `sealed` characters
 * each one read into the isolate. That is the measurement step 6.5 made of the deployed shape
 * (a compaction cost the JS heap the whole log, an own-row pull cost it again), turned into
 * something a test can hold: a compaction that reads a body, or a pull that reads a row it will
 * not answer, is a number here.
 *
 * **And it holds the sockets a test hands it** (step 6.3b's roster tests, which had a stand-in
 * of their own for a day): `getWebSockets` answers them and `getTags` each one's, so what a
 * roster closes, and what a push rings, is read off the same state the SQL runs in.
 */

/** One statement the object ran: its text, the rows it answered, and the bodies among them. */
export interface Asked {
  query: string;
  /** What the statement was bound to. */
  bindings: Cell[];
  rows: number;
  /** The `sealed` characters this statement's rows carried into JavaScript. */
  sealedChars: number;
}

type Cell = string | number | null;

/** A socket as far as `Group` touches one: whether it is open, its tags, and two spies. */
export interface FakeSocket {
  readyState: number;
  tags: string[];
  close: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
}
type Answer = Record<string, Cell>;

/**
 * What `SqlStorage.exec` answers, as far as `group.ts` reads one — **and lazy, as the real one
 * is**: a row is produced when it is asked for, so a caller that stops iterating has read no
 * further. `toArray` and `one` ask for all of them.
 */
function cursorOver(rows: Iterable<Answer>) {
  const all = () => [...rows];
  return {
    toArray: all,
    one: () => {
      const every = all();
      if (every.length !== 1) throw new Error(`one() over ${every.length} rows`);
      return every[0];
    },
    [Symbol.iterator]: () => rows[Symbol.iterator](),
  };
}

export interface FakeState {
  state: DurableObjectState;
  /** The auto-responses the constructor registered. */
  autoResponses: unknown[];
  /** Every socket `ws()` accepted, with its tags. */
  accepted: { socket: unknown; tags: string[] }[];
  /** Every statement run, in order — empty for a state whose SQL is scenery. */
  asked: Asked[];
  /** Of `asked`, the statements that wrote a row, from the `from`th on. */
  written: (from?: number) => Asked[];
  /** Run a statement of the test's own against the same database: a fixture, or a look. */
  sql: (query: string, ...bindings: Cell[]) => Answer[];
}

/**
 * Just enough of a `DurableObjectState` for `Group`.
 *
 * `"scenery"` is the state `ticket.test.ts` has always used: every `exec` answers one row that
 * satisfies both things the constructor asks — `PRAGMA table_info(acks)` finds a `heard_at`,
 * `SELECT 1 FROM log_size` finds a row — so no migration branch runs and nothing asserts on a
 * row. `"sqlite"` is a real database in memory, empty until the constructor makes its tables.
 */
export function fakeState(
  storage: "scenery" | "sqlite" = "scenery",
  sockets: FakeSocket[] = [],
): FakeState {
  const autoResponses: unknown[] = [];
  const accepted: { socket: unknown; tags: string[] }[] = [];
  const asked: Asked[] = [];

  let exec: (query: string, ...bindings: Cell[]) => ReturnType<typeof cursorOver>;
  let sql: FakeState["sql"];
  if (storage === "scenery") {
    exec = () => cursorOver([{ name: "heard_at" }]);
    sql = () => [];
  } else {
    const db = new DatabaseSync(":memory:");
    sql = (query, ...bindings) => db.prepare(query).all(...bindings) as Answer[];
    exec = (query, ...bindings) => {
      const one: Asked = {
        query: query.replace(/\s+/g, " ").trim(),
        bindings,
        rows: 0,
        sealedChars: 0,
      };
      asked.push(one);
      const statement = db.prepare(query);
      // A statement that answers no columns is run where it stands, as the runtime runs it —
      // nobody iterates an INSERT. One that answers rows steps when a row is asked for, and
      // what it read is counted as it is read.
      if (statement.columns().length === 0) {
        statement.run(...bindings);
        return cursorOver([]);
      }
      const stepping = statement.iterate(...bindings) as Iterable<Answer>;
      let read: Answer[] | null = null;
      const rows: Iterable<Answer> = {
        *[Symbol.iterator]() {
          // Read once: a second pass over the same cursor is the rows it already produced.
          if (read !== null) {
            yield* read;
            return;
          }
          const seen: Answer[] = [];
          read = seen;
          for (const row of stepping) {
            one.rows += 1;
            if (typeof row.sealed === "string") one.sealedChars += row.sealed.length;
            seen.push(row);
            yield row;
          }
        },
      };
      return cursorOver(rows);
    };
  }

  const state = {
    id: { name: "g1" },
    storage: { sql: { exec } },
    setWebSocketAutoResponse: (pair: unknown) => autoResponses.push(pair),
    acceptWebSocket: (socket: unknown, tags: string[]) => accepted.push({ socket, tags }),
    // The sockets the test handed over — none by default: a push's doorbell rings nobody.
    getWebSockets: () => sockets,
    getTags: (socket: FakeSocket) => socket.tags,
  };
  const written = (from = 0) =>
    asked.slice(from).filter((one) => /^(INSERT|UPDATE|DELETE)/.test(one.query));
  return {
    state: state as unknown as DurableObjectState,
    autoResponses,
    accepted,
    asked,
    written,
    sql,
  };
}

export const CLIENT = { end: "client" };
export const SERVER = { end: "server" };

/**
 * workerd's three globals, as far as `group.ts` uses them.
 *
 * `Response` is the awkward one: Node's refuses `status: 101` with a `RangeError`, so a real `ws()`
 * cannot return under vitest at all. The stand-in is Node's own `Response` for every other status
 * and, for a 101, the same class built as a 200 and then told its status — so `headers` is a real
 * `Headers` and what `ws()` passed as `init.headers` is read back the way a client would read it.
 */
export function stubWorkerd(): void {
  const NodeResponse = Response;
  class UpgradeResponse extends NodeResponse {
    constructor(body?: BodyInit | null, init?: ResponseInit) {
      if (init?.status !== 101) {
        super(body, init);
        return;
      }
      super(null, { headers: init.headers });
      Object.defineProperties(this, {
        status: { value: 101 },
        webSocket: { value: init.webSocket ?? null },
      });
    }
  }
  vi.stubGlobal("Response", UpgradeResponse);
  vi.stubGlobal(
    "WebSocketPair",
    class {
      0 = CLIENT;
      1 = SERVER;
    },
  );
  vi.stubGlobal(
    "WebSocketRequestResponsePair",
    class {
      constructor(
        readonly request: string,
        readonly response: string,
      ) {}
    },
  );
}
