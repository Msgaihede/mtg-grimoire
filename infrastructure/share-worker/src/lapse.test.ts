import { describe, expect, it } from "vitest";
import { fakeEnvOver, type Row, type Tables } from "@grimoire/relay/src/fakeD1";
import worker, { type Env } from "./index";
import { sweepLapsed } from "./lapse";

/**
 * The daily lapse pass (spec §6): the thing that darkens a lapsed membership's links and lights
 * them again if the membership revives.
 *
 * **Every state a share can be in other than `live` is written here**, which is why this suite
 * exists rather than a handful of extra cases in `shares.test.ts`. `public.test.ts` reaches
 * `lapsed` by poking a row into the fake table, because the route it is testing only reads the
 * column; this file is the one place that *produces* the state, so it drives `sweepLapsed`
 * itself and asserts on the rows it wrote.
 *
 * ⚠️ **`fakeD1` enforces nothing about `shares`** — its `UNIQUE_NOT_NULL` has no row for the
 * table and its `PRIMARY_KEY` entry only matters to `ON CONFLICT` — so nothing below may lean on
 * the fake refusing anything. It does not: every assertion here is about a value this pass wrote.
 * What the fake *does* do is execute the `WHERE` clause rather than recognise the statement,
 * which is the whole reason the `AND state = ?` guard can be tested at all.
 */

/** The instant every pass below is judged at, unless a case says otherwise. */
const NOW = 1_760_000_000_000;

/** An entitlement row as `reconcile` leaves it: the status is a fact, not a judgement to redo. */
function ent(
  subject: string,
  group: string | null,
  status: string,
  graceUntil: number | null = null,
): Row {
  return {
    subject,
    source: "patreon",
    external_id: subject,
    status,
    grace_until: graceUntil,
    group_id: group,
    refresh_secret: "s",
    patreon_refresh: null,
    created_at: 0,
    checked_at: 0,
    group_epoch: null,
    group_auth: null,
  };
}

/** One published share, in whichever of the three states the case is about. */
function share(id: string, group: string, state: string, updatedAt = 0): Row {
  return {
    id,
    group_id: group,
    folder_uid: null,
    title: "Binder",
    owner_name: "G",
    card_count: 1,
    total_value: null,
    currency: null,
    marketplace: null,
    fields: "[]",
    object_key: "k",
    bytes: 1,
    state,
    created_at: 0,
    updated_at: updatedAt,
  };
}

/** The share Worker's `Env` over tables the caller holds: `fakeEnvOver`, plus the cast the
 * difference between the two Workers' `Env`s needs. The sweep reads `DB` and nothing else. */
function lapseEnv(tables: Tables): Env {
  return fakeEnvOver(tables) as unknown as Env;
}

function rowOf(tables: Tables, id: string): { state: string; updated_at: number } {
  const found = tables.shares.find((row) => row.id === id);
  if (found === undefined) throw new Error(`no share ${id}`);
  return found as unknown as { state: string; updated_at: number };
}

function stateOf(tables: Tables, id: string): string {
  return rowOf(tables, id).state;
}

describe("the lapse sweep", () => {
  it("darkens a dead subject's shares", async () => {
    const tables: Tables = {
      entitlements: [ent("s1", "g1", "dead")],
      shares: [share("a", "g1", "live")],
    };
    await sweepLapsed(lapseEnv(tables));
    expect(stateOf(tables, "a")).toBe("lapsed");
  });

  /** Decision 5's other half: a membership that revives must light the links again. */
  it("lights them again when the subject is active", async () => {
    const tables: Tables = {
      entitlements: [ent("s1", "g1", "active")],
      shares: [share("a", "g1", "lapsed")],
    };
    await sweepLapsed(lapseEnv(tables));
    expect(stateOf(tables, "a")).toBe("live");
  });

  /**
   * `grace` serves. A declined card is a failed payment Patreon retries, not a cancellation the
   * reader chose — `entitlement.ts` argues it at length and this pass has to agree, or a reader
   * whose card bounced would find their links dark before Patreon had finished trying.
   */
  it("leaves a subject in their grace window serving", async () => {
    const tables: Tables = {
      entitlements: [ent("s1", "g1", "grace", NOW + 60_000)],
      shares: [share("a", "g1", "live"), share("b", "g1", "lapsed")],
    };
    await sweepLapsed(lapseEnv(tables), NOW);
    expect(stateOf(tables, "a")).toBe("live");
    expect(stateOf(tables, "b")).toBe("live");
  });

  /** The deadline instant is the last one inside the window, as `decide` and `settle` read it. */
  it("still serves at the deadline's own instant", async () => {
    const tables: Tables = {
      entitlements: [ent("s1", "g1", "grace", NOW)],
      shares: [share("a", "g1", "live")],
    };
    await sweepLapsed(lapseEnv(tables), NOW);
    expect(stateOf(tables, "a")).toBe("live");
  });

  /**
   * ⚠️ **A stored `grace` whose window has closed does not serve** — issue #1117. The relay's
   * `/token` settles such a row `dead` the moment it is asked, but the row itself says `grace`
   * until the relay's cron reaches it, and a row Patreon refuses on every pass might never be
   * reached successfully. Read as a bare status, its links stayed live for ever.
   */
  it("darkens a grace window that has closed", async () => {
    const tables: Tables = {
      entitlements: [ent("s1", "g1", "grace", NOW - 1)],
      shares: [share("a", "g1", "live")],
    };
    await sweepLapsed(lapseEnv(tables), NOW);
    expect(stateOf(tables, "a")).toBe("lapsed");
  });

  /** `settle` reads a window with no deadline as closed, and so does this pass. */
  it("darkens a grace row with no deadline", async () => {
    const tables: Tables = {
      entitlements: [ent("s1", "g1", "grace", null), ent("s2", "g2", "grace", 0)],
      shares: [share("a", "g1", "live"), share("b", "g2", "live")],
    };
    await sweepLapsed(lapseEnv(tables), NOW);
    expect(stateOf(tables, "a")).toBe("lapsed");
    expect(stateOf(tables, "b")).toBe("lapsed");
  });

  /**
   * The reader's own press is terminal and the cron must never undo it.
   *
   * ⚠️ **This is the assertion the `AND state = ?` guard exists for**: `g1` is serving, so its row
   * is inside the re-lighting statement's `group_id IN (…)`, and the guard is the only thing
   * standing between a withdrawn binder and a link that works again. Delete the clause and this
   * test goes red.
   */
  it("never resurrects a revoked share", async () => {
    const tables: Tables = {
      entitlements: [ent("s1", "g1", "active")],
      shares: [share("a", "g1", "revoked")],
    };
    await sweepLapsed(lapseEnv(tables));
    expect(stateOf(tables, "a")).toBe("revoked");
  });

  /**
   * A group with shares and **no entitlement row at all** — the state a binding that moved leaves
   * behind, since `/claim` moves a membership rather than refusing one.
   *
   * Fail closed, for `decide`'s default branch's reason: publishing is gated on a membership, so
   * a group nothing entitles is a group nobody is paying for, and serving on it is invisible
   * where darkening is visible within a day. It costs the reader nothing permanent — `lapsed` is
   * the reversible state, and the case below is what takes it back.
   */
  it("darkens a share whose group has no entitlement row", async () => {
    const tables: Tables = {
      entitlements: [ent("s1", "g-other", "active")],
      shares: [share("a", "g1", "live")],
    };
    await sweepLapsed(lapseEnv(tables));
    expect(stateOf(tables, "a")).toBe("lapsed");
  });

  /**
   * **Serving is an allowlist and not "anything but `dead`".** The relay writes one of three
   * strings today, but `entitlements.status` is a TEXT column and the fail-closed branch is worth
   * having on this side too: a status this code has never seen is the *absence* of a "yes", and
   * a pass that read it as one would serve a membership nobody had checked.
   */
  it("darkens a status this code has never seen", async () => {
    const tables: Tables = {
      entitlements: [ent("s1", "g1", "pending_review")],
      shares: [share("a", "g1", "live")],
    };
    await sweepLapsed(lapseEnv(tables));
    expect(stateOf(tables, "a")).toBe("lapsed");
  });

  /**
   * **`WHERE group_id = ?` is not decoration.** Without it one dead subject would darken every
   * share on the account, which is the single worst thing this pass could do and the one failure
   * a daily job would take a day to notice.
   */
  it("moves only the group the status is about", async () => {
    const tables: Tables = {
      entitlements: [ent("s1", "g1", "dead"), ent("s2", "g2", "active")],
      shares: [share("a", "g1", "live"), share("b", "g2", "live"), share("c", "g2", "lapsed")],
    };
    await sweepLapsed(lapseEnv(tables));
    expect(stateOf(tables, "a")).toBe("lapsed");
    expect(stateOf(tables, "b")).toBe("live");
    expect(stateOf(tables, "c")).toBe("live");
  });

  /**
   * **A share the pass does not move keeps its `updated_at`.** The shell page renders that stamp,
   * and `shares.ts` takes the trouble to read the clock once per request precisely so a row that
   * was not edited does not look edited — a sweep that restamped every row nightly would make
   * every binder in the world claim it was refreshed at 03:30 this morning.
   */
  it("does not restamp a share it leaves where it is", async () => {
    const tables: Tables = {
      entitlements: [ent("s1", "g1", "active")],
      shares: [share("a", "g1", "live", 1_000), share("b", "g1", "revoked", 2_000)],
    };
    await sweepLapsed(lapseEnv(tables));
    expect(rowOf(tables, "a").updated_at).toBe(1_000);
    expect(rowOf(tables, "b").updated_at).toBe(2_000);
  });

  /**
   * **Nor the share it does move, in either direction.** `updated_at` is the date the shell's
   * OpenGraph card puts on the snapshot, and a lapse or a revival changes the row's state and not
   * one byte of what the owner published. Until 2026-10-01 both directions restamped it, so a
   * share relit after a month of lapse previewed in Discord as *updated today*.
   */
  it("keeps the publish date through a lapse and a revival", async () => {
    const tables: Tables = {
      entitlements: [ent("s1", "g1", "dead")],
      shares: [share("a", "g1", "live", 1_000)],
    };
    await sweepLapsed(lapseEnv(tables));
    expect(stateOf(tables, "a")).toBe("lapsed");
    expect(rowOf(tables, "a").updated_at).toBe(1_000);

    tables.entitlements[0].status = "active";
    await sweepLapsed(lapseEnv(tables));
    expect(stateOf(tables, "a")).toBe("live");
    expect(rowOf(tables, "a").updated_at).toBe(1_000);
  });

  /** Idempotent: the second pass of a day finds nothing left to say. */
  it("changes nothing on a second pass", async () => {
    const tables: Tables = {
      entitlements: [ent("s1", "g1", "dead")],
      shares: [share("a", "g1", "live", 1_000)],
    };
    await sweepLapsed(lapseEnv(tables));
    await sweepLapsed(lapseEnv(tables));
    expect(stateOf(tables, "a")).toBe("lapsed");
    expect(rowOf(tables, "a").updated_at).toBe(1_000);
  });

  /**
   * ⚠️ **An unbound entitlement must not freeze the pass.** A subject who has connected Patreon
   * and claimed no group has a NULL `group_id`, and a NULL in a `NOT IN` list makes the darkening
   * statement's condition NULL for every row — so without `group_id IS NOT NULL` in the serving
   * subquery, one such subject would leave every dead group's links serving for ever. The fake
   * answers `NOT IN` with SQLite's NULL rule, so deleting that clause is a red test here.
   */
  it("still darkens while an active subject has claimed no group", async () => {
    const tables: Tables = {
      entitlements: [ent("s1", "g1", "dead"), ent("s2", null, "active")],
      shares: [share("a", "g1", "live")],
    };
    await sweepLapsed(lapseEnv(tables));
    expect(stateOf(tables, "a")).toBe("lapsed");
  });

  /**
   * **Two statements, however many groups have ever shared** — issue #1194. Revoked rows are
   * tombstones that stay, so the set of groups with a row only grows; a pass that sent a statement
   * per group would have crossed the free plan's fifty queries an invocation and thrown every day
   * after. Sixty groups is past that line, and every one of them still moves.
   */
  it("sends a fixed number of statements however many groups have shared", async () => {
    const groups = Array.from({ length: 60 }, (_, index) => `g${index}`);
    const tables: Tables = {
      entitlements: groups.map((group, index) =>
        ent(`s${index}`, group, index % 2 === 0 ? "dead" : "active"),
      ),
      shares: groups.map((group, index) =>
        share(`share${index}`, group, index % 2 === 0 ? "live" : "lapsed"),
      ),
    };
    const inner = fakeEnvOver(tables).DB;
    let statements = 0;
    let batches = 0;
    const env = {
      DB: {
        prepare: (sql: string) => inner.prepare(sql),
        batch: (sent: D1PreparedStatement[]) => {
          batches += 1;
          statements += sent.length;
          return inner.batch(sent);
        },
      },
    } as unknown as Env;
    await sweepLapsed(env);
    expect(batches).toBe(1);
    expect(statements).toBe(2);
    groups.forEach((_, index) => {
      expect(stateOf(tables, `share${index}`)).toBe(index % 2 === 0 ? "lapsed" : "live");
    });
  });

  /** A relay with no shares on it is every relay until the first one is published. */
  it("runs cleanly when nothing has ever been shared", async () => {
    const tables: Tables = { entitlements: [ent("s1", "g1", "active")], shares: [] };
    await sweepLapsed(lapseEnv(tables));
    expect(tables.shares).toEqual([]);
  });
});

/**
 * The wiring, which no test above can see: `sweepLapsed` could be perfect and unreachable if the
 * handler were never exported, and `wrangler.jsonc`'s trigger would then fire into a Worker that
 * does nothing at 03:30 every morning for ever.
 */
describe("the scheduled handler", () => {
  it("runs the sweep", async () => {
    const tables: Tables = {
      entitlements: [ent("s1", "g1", "dead")],
      shares: [share("a", "g1", "live")],
    };
    const controller = {
      scheduledTime: 9_999,
      cron: "30 3 * * *",
      noRetry: () => {},
    } as ScheduledController;
    await worker.scheduled(controller, lapseEnv(tables));
    expect(stateOf(tables, "a")).toBe("lapsed");
  });
});
