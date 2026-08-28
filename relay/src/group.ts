import { compact, since, type Row } from "./log";

/**
 * One Durable Object per pairing group. It stores sealed envelopes, hands them back in the
 * group's own order, and forgets the ones every device has consumed — and it can decrypt
 * nothing it holds, because the group key never leaves the paired devices.
 *
 * **This class is deliberately thin.** Every decision it makes about *which* rows — the pull
 * window, the ordering, the compaction floor, the thirty-day tail — is delegated to `log.ts`,
 * where it is a pure function the root vitest can test without workerd. What is left here is
 * SQL and routing. See `log.ts`'s module doc for why the split is drawn there.
 */

/**
 * The envelope as `sync_engine::wire` seals it, with only the fields the relay reads named.
 * `sealed` is the ciphertext and is passed through untouched; the clock fields are copied out
 * so the relay can sort a log it cannot read.
 */
export interface Envelope {
  group: string;
  device: string;
  epoch: number;
  hlcMs: number;
  hlcCtr: number;
  sealed: string;
}

/**
 * The stored shape, in SQLite's snake_case. Written as a `type` and not an `interface` on
 * purpose: `SqlStorage.exec<T>` constrains `T` to `Record<string, SqlStorageValue>`, and a TS
 * interface has no implicit index signature while a type alias does.
 */
type LogRow = {
  seq: number;
  device: string;
  epoch: number;
  hlc_ms: number;
  hlc_ctr: number;
  sealed: string;
  stored_at: number;
};

type AckRow = { device: string; cursor: number };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export class Group implements DurableObject {
  private readonly sql: SqlStorage;

  /**
   * The name this object was addressed by, when the runtime exposes it. It is a cross-check
   * and not the primary one — see `assertGroup`.
   */
  private readonly ownName: string | undefined;

  constructor(state: DurableObjectState) {
    this.sql = state.storage.sql;
    this.ownName = state.id.name;

    // `AUTOINCREMENT` and not a bare rowid, and the reason is compaction itself: a plain
    // `INTEGER PRIMARY KEY` reuses the highest rowid after a delete, so a pass that emptied
    // the log would restart `seq` at 1 and every device holding a cursor of 5 would silently
    // skip the next five rows. `AUTOINCREMENT` is the documented way to make a rowid
    // monotonic for the life of the table.
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS log (
         seq       INTEGER PRIMARY KEY AUTOINCREMENT,
         device    TEXT    NOT NULL,
         epoch     INTEGER NOT NULL,
         hlc_ms    INTEGER NOT NULL,
         hlc_ctr   INTEGER NOT NULL,
         sealed    TEXT    NOT NULL,
         stored_at INTEGER NOT NULL
       );`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS acks (
         device TEXT    PRIMARY KEY,
         cursor INTEGER NOT NULL
       );`,
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // The Worker only ever forwards `/g/{group}/{action}`, and it validated both halves
    // before choosing which object to address. Re-reading them here keeps this class
    // self-contained rather than trusting a shape it does not enforce.
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 3 || parts[0] !== "g") return json({ error: "not found" }, 404);
    const [, group, action] = parts;

    switch (action) {
      case "push":
        return this.push(request, group);
      case "pull":
        return this.pull(url, group);
      case "ack":
        return this.ack(request);
      case "ws":
        return this.ws();
      default:
        return json({ error: "not found" }, 404);
    }
  }

  /**
   * **A body naming a different group is refused.** A Durable Object is addressed by id, and
   * the id is `idFromName(group)` over the same path segment — so an envelope whose `group`
   * disagrees with the path has reached an object that is not its own. That is either a client
   * bug worth seeing as a 409 or an attempt to write into somebody else's log, and neither is
   * something to store.
   *
   * The path segment is the authoritative comparison because it is what selected this object.
   * `state.id.name` is checked too where the runtime supplies it — it is the same fact from
   * the other side, and it is `undefined` for an id that was not made from a name.
   */
  private assertGroup(group: string, claimed: string): Response | undefined {
    if (claimed !== group) return json({ error: "group mismatch" }, 409);
    if (this.ownName !== undefined && this.ownName !== group) {
      return json({ error: "group mismatch" }, 409);
    }
    return undefined;
  }

  private async push(request: Request, group: string): Promise<Response> {
    let envelope: Envelope;
    try {
      envelope = (await request.json()) as Envelope;
    } catch {
      return json({ error: "unreadable body" }, 400);
    }

    if (
      typeof envelope?.group !== "string" ||
      typeof envelope.device !== "string" ||
      typeof envelope.sealed !== "string" ||
      !Number.isFinite(envelope.epoch) ||
      !Number.isFinite(envelope.hlcMs) ||
      !Number.isFinite(envelope.hlcCtr)
    ) {
      return json({ error: "malformed envelope" }, 400);
    }

    const mismatch = this.assertGroup(group, envelope.group);
    if (mismatch) return mismatch;

    const stored = this.sql
      .exec<{ seq: number }>(
        `INSERT INTO log (device, epoch, hlc_ms, hlc_ctr, sealed, stored_at)
              VALUES (?, ?, ?, ?, ?, ?)
           RETURNING seq`,
        envelope.device,
        envelope.epoch,
        envelope.hlcMs,
        envelope.hlcCtr,
        envelope.sealed,
        Date.now(),
      )
      .one();

    return json({ cursor: stored.seq });
  }

  private pull(url: URL, group: string): Response {
    const rawCursor = url.searchParams.get("since") ?? "0";
    const cursor = Number(rawCursor);
    const device = url.searchParams.get("device") ?? "";
    if (!Number.isFinite(cursor) || cursor < 0) return json({ error: "bad cursor" }, 400);

    const rows = this.rows();

    // **The cursor handed back is the head of the whole log, not of the returned slice.**
    // The slice has the puller's own rows filtered out of it, and a cursor taken from the
    // slice would sit below them — so the device would re-ask for its own rows on every pull,
    // for as long as they survive compaction.
    const head = rows.reduce((max, row) => Math.max(max, row.seq), cursor);

    return json({
      envelopes: since(rows, cursor, device).map((row) => ({
        group,
        device: row.device,
        epoch: row.epoch,
        hlcMs: row.hlcMs,
        hlcCtr: row.hlcCtr,
        sealed: row.sealed,
      })),
      cursor: head,
    });
  }

  private async ack(request: Request): Promise<Response> {
    let body: { device?: unknown; cursor?: unknown };
    try {
      body = (await request.json()) as { device?: unknown; cursor?: unknown };
    } catch {
      return json({ error: "unreadable body" }, 400);
    }
    if (typeof body?.device !== "string" || typeof body.cursor !== "number") {
      return json({ error: "malformed ack" }, 400);
    }

    // `max(...)` and not a plain assignment: an ack is a watermark, and a retry that arrives
    // out of order must not walk a device's cursor backwards into rows it has already folded.
    this.sql.exec(
      `INSERT INTO acks (device, cursor) VALUES (?, ?)
         ON CONFLICT (device) DO UPDATE SET cursor = max(acks.cursor, excluded.cursor)`,
      body.device,
      body.cursor,
    );

    this.compactNow();
    return new Response(null, { status: 204 });
  }

  /**
   * §7.7's "compact on ack". The decision of what survives is `log.compact`'s; all this does
   * is delete what it did not return. Row-at-a-time because the set is tiny — three devices
   * at fifty edits a day produce a few stored rows a day, and only rows past the thirty-day
   * tail are ever candidates.
   */
  private compactNow(): void {
    const rows = this.rows();
    const acks = new Map<string, number>();
    for (const ack of this.sql.exec<AckRow>(`SELECT device, cursor FROM acks`)) {
      acks.set(ack.device, ack.cursor);
    }

    const keep = new Set(compact(rows, acks, Date.now()).map((row) => row.seq));
    for (const row of rows) {
      if (!keep.has(row.seq)) this.sql.exec(`DELETE FROM log WHERE seq = ?`, row.seq);
    }
  }

  /**
   * The route §7.7 describes and this PR does not build. It is kept in the object's shape so
   * the PR that adds hibernatable WebSockets adds a handler rather than a route: `reqwest` has
   * no WebSocket client, `tokio-tungstenite` does not compile to `wasm32-unknown-unknown`, and
   * a socket from the page would need `tauri.conf.json`'s `connect-src` widened — a decision
   * to take once, for all three targets, in that PR. Until then the client polls.
   */
  private ws(): Response {
    return json({ error: "websocket fan-out is not implemented; use pull" }, 501);
  }

  private rows(): Row[] {
    return this.sql
      .exec<LogRow>(`SELECT seq, device, epoch, hlc_ms, hlc_ctr, sealed, stored_at FROM log`)
      .toArray()
      .map((row) => ({
        seq: row.seq,
        device: row.device,
        epoch: row.epoch,
        hlcMs: row.hlc_ms,
        hlcCtr: row.hlc_ctr,
        sealed: row.sealed,
        storedAt: row.stored_at,
      }));
  }
}
