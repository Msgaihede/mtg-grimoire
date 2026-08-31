import { compact, deviceTag, headFrame, notifyTargets, since, type Row } from "./log";

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

  /**
   * The `DurableObjectState` itself, kept for the hibernation API — `acceptWebSocket`,
   * `getWebSockets` and `getTags` all hang off it. This class `implements DurableObject`
   * rather than extending it, so there is no inherited `ctx` and this field is the only
   * handle. Cloudflare's samples all say `this.ctx`; here it is `this.state`.
   */
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
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
        return this.ws(request, url);
      case "drop":
        return this.drop();
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

    this.notify(stored.seq, envelope.device);

    return json({ cursor: stored.seq });
  }

  private pull(url: URL, group: string): Response {
    const rawCursor = url.searchParams.get("since") ?? "0";
    const cursor = Number(rawCursor);
    const device = url.searchParams.get("device") ?? "";
    if (!Number.isFinite(cursor) || cursor < 0) return json({ error: "bad cursor" }, 400);

    const rows = this.rowsSince(cursor);

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

    // What this device had acked before, so the compaction below runs only when it could
    // possibly change anything. `-1` and not `0`: a device whose stored cursor is genuinely
    // `0` must still be told apart from one that has never acked.
    const prior = this.sql
      .exec<{ cursor: number }>(`SELECT cursor FROM acks WHERE device = ?`, body.device)
      .toArray();
    const before = prior.length > 0 ? prior[0].cursor : -1;

    // `max(...)` and not a plain assignment: an ack is a watermark, and a retry that arrives
    // out of order must not walk a device's cursor backwards into rows it has already folded.
    this.sql.exec(
      `INSERT INTO acks (device, cursor) VALUES (?, ?)
         ON CONFLICT (device) DO UPDATE SET cursor = max(acks.cursor, excluded.cursor)`,
      body.device,
      body.cursor,
    );

    // A re-ack of a value already stored cannot move the floor, and `compactNow` is two full
    // table scans plus a DELETE per doomed row.
    if (body.cursor > before) this.compactNow();
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
   * Tell every other connected device that the log moved.
   *
   * **No coalescing, and that is deliberate.** A 50 000-row import is 250 sequential POSTs, so
   * a burst emits 250 frames per peer — but outgoing messages are free, the object is already
   * awake handling the push, and the receiving device debounces ~1 s and makes one round trip.
   * Coalescing here would need a timer or an alarm, and both block hibernation. If a live pass
   * ever shows the burst mattering, the escape hatch is a `?notify=1` flag the client sets on
   * the final chunk of a push run — named so it is not re-derived, and not built.
   */
  private notify(cursor: number, from: string): void {
    const sockets = this.state.getWebSockets().map((ws) => ({
      ws,
      tag: this.state.getTags(ws)[0],
      open: ws.readyState === WebSocket.OPEN,
    }));
    const frame = headFrame(cursor, from);
    for (const target of notifyTargets(sockets, from)) {
      target.ws.send(frame);
    }
  }

  /**
   * §7.7's fan-out, as a hint rather than a delivery.
   *
   * **`acceptWebSocket` and never `accept()`.** The latter bills duration for the entire time
   * the socket is connected, at a flat 128 MB — one idle connection is ~10 800 of the
   * 13 000 GB-s/day free allowance. Worse, a single `accept()` anywhere disables hibernation
   * for the whole object. There is no error either way; the only signal is the bill.
   *
   * **No session map and no constructor rehydration.** Every Cloudflare sample builds a
   * `Map<WebSocket, …>` in `fetch` and rebuilds it from `getWebSockets()` on wake, because
   * in-memory state is discarded at hibernation. `getWebSockets()` already returns hibernated
   * sockets — that is what makes the samples work — so calling it at fan-out time is the whole
   * mechanism, and the path this repo could not test (`evictDurableObject` needs
   * `@cloudflare/vitest-pool-workers`) does not exist to be got wrong.
   */
  private ws(request: Request, url: URL): Response {
    // Lower-cased before comparing: RFC 6455 makes the token case-insensitive, every
    // Cloudflare sample compares case-sensitively, and whether the runtime normalises first
    // is not documented.
    const upgrade = request.headers.get("Upgrade")?.toLowerCase();
    if (upgrade !== "websocket") {
      return json({ error: "expected Upgrade: websocket" }, 426);
    }

    const device = url.searchParams.get("device") ?? "";
    if (device === "") return json({ error: "device required" }, 400);

    // Numeric keys `0` and `1`, not `client`/`server` — which is why every sample destructures
    // through `Object.values`. Index 0 is the end handed back to the caller.
    const [client, server] = Object.values(new WebSocketPair());

    this.state.acceptWebSocket(server, [deviceTag(device)]);

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Required so a stray frame is consumed rather than dropped.
   *
   * **A missing or misspelled handler is a silent no-op** — `workerd` drops the message with no
   * error and no log, while still waking the object and still billing the request. That failure
   * reads exactly like "the client is not sending anything", so the handler exists even though
   * nothing is expected to arrive: the client's keepalive is a *protocol* ping, which the
   * runtime answers itself without waking anything and without calling this.
   */
  // Both parameters are unused by design — the runtime calls this by name, and there is
  // nothing to inspect. `no-unused-vars`'s `args: "after-used"` only forgives a leading unused
  // parameter that precedes one that IS used (see `index.ts`'s `scheduled`); neither parameter
  // here has that cover, so the disable is necessary rather than decorative (see `pair.ts`).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): void {}

  /**
   * Nothing to clean up — `getWebSockets()` is the registry, not a list this class maintains.
   *
   * **`ws.close()` here would be redundant.** `compatibility_date` is `2026-08-27`, past
   * `2026-04-07`, so `web_socket_auto_reply_to_close` is on by default and the runtime
   * completes the close handshake itself. On an older date, omitting it gave the client a
   * `1006`; that trap is closed for this Worker.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  webSocketClose(_ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): void {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  webSocketError(_ws: WebSocket, _error: unknown): void {}

  /**
   * Empty this group's log. Called only by the entitlement layer when a membership ends
   * (spec §7.1) — **never by a device**, which is why it is not on the router's public
   * `ROUTE` regex but on an internal path the Worker builds itself.
   *
   * `acks` is emptied too. Leaving it would mean a reader who resubscribes has a compaction
   * floor derived from cursors into a log that no longer exists.
   */
  private drop(): Response {
    this.sql.exec(`DELETE FROM log`);
    this.sql.exec(`DELETE FROM acks`);
    // 4001 is in the private range, so the Rust client can tell "you were removed" from any
    // transport-level close. There is no close-all API; the loop is it. `state.abort()` would
    // also do it and is the wrong tool — it logs an error application code cannot catch.
    for (const ws of this.state.getWebSockets()) {
      ws.close(4001, "group dropped");
    }
    return new Response(null, { status: 204 });
  }

  private rows(): Row[] {
    return this.toRows(
      this.sql
        .exec<LogRow>(`SELECT seq, device, epoch, hlc_ms, hlc_ctr, sealed, stored_at FROM log`)
        .toArray(),
    );
  }

  /**
   * The rows a pull can possibly return: everything past the cursor.
   *
   * **`head` is still the head of the whole log**, which is what `pull`'s comment requires,
   * and the arithmetic survives the filter: `reduce` seeds with `cursor`, and a row at or
   * below the cursor could never have been the maximum of a set seeded that way. A device
   * that is fully caught up sees an empty set and `head === cursor`, which is true.
   *
   * `compactNow` deliberately still calls `rows()` — its floor is computed across every device
   * and a bounded read would compute it against a slice.
   */
  private rowsSince(cursor: number): Row[] {
    return this.toRows(
      this.sql
        .exec<LogRow>(
          `SELECT seq, device, epoch, hlc_ms, hlc_ctr, sealed, stored_at
             FROM log WHERE seq > ?`,
          cursor,
        )
        .toArray(),
    );
  }

  /**
   * The `LogRow` → `Row` shape shared by `rows()` and `rowsSince()` — same columns, different
   * `WHERE`. Kept as one mapper so a `Row` field added or renamed has one call site instead of
   * two silently drifting; the two *query* methods stay separate on purpose (see `rowsSince`'s
   * comment on `compactNow`).
   */
  private toRows(raw: LogRow[]): Row[] {
    return raw.map((row) => ({
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
