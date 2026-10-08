import { admitToLog, isEnvelope } from "./admit";
import {
  CLOSE_DROPPED,
  CLOSE_REMOVED,
  compact,
  departures,
  deviceTag,
  HEARD_REFRESH_MS,
  headFrame,
  inGroupOrder,
  notifyTargets,
  isNewerRoster,
  pageLength,
  pageLimit,
  parseRoster,
  PULL_PAGE_CHARS,
  removedSockets,
  taggedDevice,
  type Ack,
} from "./log";
import { KEEPALIVE, selectedProtocol } from "./ticket";

/**
 * One Durable Object per pairing group. It stores sealed envelopes, hands them back in the
 * group's own order, and forgets the ones every device has consumed — and it can decrypt
 * nothing it holds, because the group key never leaves the paired devices.
 *
 * **This class is deliberately thin.** Every decision it makes about *which* rows — the pull
 * window, the ordering, the compaction floor, the thirty-day tail, who has left — is delegated to
 * `log.ts`, and the one refusal it makes itself, the quota, to `admit.ts`; both are pure functions
 * the root vitest can test without workerd. What is left here is SQL and routing. See `log.ts`'s
 * module doc for why the split is drawn there.
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
  device: string;
  epoch: number;
  hlc_ms: number;
  hlc_ctr: number;
  sealed: string;
};

/**
 * A stored row as the envelope a pull answers it as — **the six fields in the order every
 * answer has spelled them**, which is what `JSON.stringify` writes and what the unpaged
 * answer's bytes are held to.
 */
function envelopeOf(group: string, row: LogRow): Envelope {
  return {
    group,
    device: row.device,
    epoch: row.epoch,
    hlcMs: row.hlc_ms,
    hlcCtr: row.hlc_ctr,
    sealed: row.sealed,
  };
}

/**
 * About how many sealed characters the unpaged answer writes between two turns of its stream:
 * a page's worth, so the most this isolate holds of a log it is streaming is what a page
 * would hold.
 */
const STREAM_CHUNK_CHARS = PULL_PAGE_CHARS;

/**
 * `heard_at` is nullable in the type because it is nullable in the column — `ALTER TABLE` cannot
 * add a `NOT NULL` without a default, see the constructor. Nothing writes a NULL, and the one
 * reader maps one to "heard now", the direction that keeps rows.
 */
type AckRow = { device: string; cursor: number; heard_at: number | null };

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

    // **The keepalive a browser can send, answered by the runtime and not by this class.** A page
    // cannot send a protocol ping, so the web app sends the text frame `ping` every 45 s where the
    // desktop sends the real thing (`ticket.ts`'s `KEEPALIVE`). As an ordinary message that would
    // wake this object from hibernation twice a minute per open tab, for `webSocketMessage` to
    // drop — and waking is what bills duration. Registered here, the runtime answers `pong` itself
    // and the object stays asleep.
    //
    // What Cloudflare's documentation says, read 2026-10-04. The state API page: a matching
    // request is answered "without waking WebSockets in hibernation and incurring billable
    // duration charges". The pricing page's footnote on *duration*: auto-response messages "will
    // not incur additional wall-clock time, and so they will not be charged".
    // ⚠️ **Neither sentence is about the request line, and that one is not free.** The footnote on
    // *requests* exempts incoming protocol pings by name and bills every other incoming message at
    // twenty to one; it does not mention auto-response. Read as written, a tab's `ping` is an
    // incoming message: 1 920 a day for a tab left open the whole day, which is **96 billed
    // requests** — against the ~25 a day an idle group of native devices costs
    // (`infrastructure/relay/README.md`, Cost), and the 100 000 a day the free plan allows. An eight-hour session
    // is 32. The desktop's protocol ping stays free either way. Whether the dashboard counts them
    // is something only a deployed socket shows.
    //
    // In the constructor because every Cloudflare sample puts it there: it runs on each wake and
    // setting the same pair twice changes nothing. It applies to every socket accepted through
    // `acceptWebSocket`, the desktop's included — which never sends the text and so never meets it.
    state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(KEEPALIVE.request, KEEPALIVE.response),
    );

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
    // `heard_at` is when the relay last heard from the device — every ack sets it, a pull
    // refreshes it daily — and it is how a device that is never coming back stops holding the
    // compaction floor (`log.compact`, `ACK_TTL_MS`). **Nullable in a fresh table too**, so
    // every object has one shape whether it was created with the column or migrated to it.
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS acks (
         device   TEXT    PRIMARY KEY,
         cursor   INTEGER NOT NULL,
         heard_at INTEGER
       );`,
    );
    // **An object created before `heard_at` existed gets it here, on its first wake after the
    // deploy.** There is no migration step for a Durable Object — each one's schema is whatever
    // its own constructor last made it — and `CREATE TABLE IF NOT EXISTS` does nothing to a table
    // that is already there, so the column is added when missing and not otherwise.
    //
    // **Backfilled with the migration's own time, not left NULL and not zero.** Zero would be
    // "last heard in 1970": every device of every existing group would be ninety days stale at
    // once, drop out of the floor, and the next ack would compact the inbox of a device that is
    // merely asleep. "Heard at the deploy" is conservative in the other direction — a device that
    // was already gone keeps its pin for one more window, or until a rotation's roster names it
    // gone, which is the cost the old behaviour charged for ever.
    const ackColumns = this.sql.exec<{ name: string }>(`PRAGMA table_info(acks)`).toArray();
    if (!ackColumns.some((column) => column.name === "heard_at")) {
      this.sql.exec(`ALTER TABLE acks ADD COLUMN heard_at INTEGER`);
      this.sql.exec(`UPDATE acks SET heard_at = ?`, Date.now());
    }

    // The devices a rotation's manifest has omitted (`roster`). `at` is when the object learned
    // it, and is written and not read — the same "when did this happen" a support conversation
    // asks of `group_devices.first_seen`, and nothing else could answer once it had passed.
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS departed (
         device TEXT    PRIMARY KEY,
         at     INTEGER NOT NULL
       );`,
    );

    // The epoch of the last roster applied, one row — what lets a roster post that lost a race to a
    // newer rotation's be told apart and ignored (`log.isNewerRoster`).
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS roster_epoch (
         id    INTEGER PRIMARY KEY CHECK (id = 1),
         epoch INTEGER NOT NULL
       );`,
    );

    // **The log's size as a running total, one row, and not a `sum()` read per push.** A sum
    // over `sealed` reads every row in the log on every push, and Durable Object SQL bills rows
    // read — so the cost of the check would grow with exactly the size the quota exists to bound,
    // and a group at the cap would pay a read of its whole 128 MiB to be told it is full.
    // `databaseSize` is not an answer either: it is the file's high-water mark and does not
    // shrink when compaction deletes, so a group that once met the cap would meet it for ever.
    //
    // The total costs a point read and a row written per push instead, and **its risk is drift**:
    // a path that deleted from `log` without adjusting it would leave it wrong for good. So
    // compaction, which already visits every row and reads its length, recomputes it exactly and
    // writes it back — any drift lasts until the next ack that moves a cursor.
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS log_size (
         id    INTEGER PRIMARY KEY CHECK (id = 1),
         chars INTEGER NOT NULL
       );`,
    );
    // Once per object, on the first wake that finds no row: an object that held a log before
    // this table existed pays one full read to seed it, and every later wake pays a point read.
    if (this.sql.exec(`SELECT 1 FROM log_size WHERE id = 1`).toArray().length === 0) {
      this.sql.exec(
        `INSERT INTO log_size (id, chars) SELECT 1, coalesce(sum(length(sealed)), 0) FROM log`,
      );
    }
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
      case "roster":
        return this.roster(request);
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
    let envelope: unknown;
    try {
      envelope = await request.json();
    } catch {
      return json({ error: "unreadable body" }, 400);
    }
    if (!isEnvelope(envelope)) return json({ error: "malformed envelope" }, 400);

    const mismatch = this.assertGroup(group, envelope.group);
    if (mismatch) return mismatch;

    // The size, the epoch and the clock were refused in the Worker, before this request cost a
    // Durable Object request (`admit.ts`). The quota is the one check that needs this object's
    // own state. Nothing awaits between the read and the two writes, so no other request can
    // land in between and both be admitted against the same total.
    const size = () =>
      this.sql.exec<{ chars: number }>(`SELECT chars FROM log_size WHERE id = 1`).one().chars;
    let full = admitToLog(size(), envelope.sealed.length);
    // **Compact before refusing, and this is what makes the quota "not now" rather than "never".**
    // Compaction otherwise runs only when an ack moves a cursor or a roster arrives — and a group
    // at its cap refuses every push, so no device's head moves, no ack advances, and rows that
    // aged past the thirty-day tail behind every device's ack would never be deleted: the group
    // would stay full for good. A full scan, paid only by a push that is about to be refused.
    if (full) {
      this.compactNow();
      full = admitToLog(size(), envelope.sealed.length);
    }
    if (full) return json({ error: full.error, code: full.code }, full.status);

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
    this.sql.exec(`UPDATE log_size SET chars = chars + ? WHERE id = 1`, envelope.sealed.length);

    this.notify(stored.seq, envelope.device);

    return json({ cursor: stored.seq });
  }

  /**
   * What the group has said since `since`, to `device` — whole, or a page of it.
   *
   * **Two answers, chosen by whether the request names a `limit`, and the difference is who is
   * asking.** A request with none is every desktop and Android build released before step 6.5b:
   * it decides its holds, its release, its conversions and its baselines on whatever one answer
   * hands it and asks nothing more after it, so it is answered everything, as it always was
   * ([`pullWhole`]) — **no cap is ever put on a request that asked for none**. A request with one
   * is a pager, and is answered a page ([`pullPage`]).
   *
   * **Neither reads a row of the caller's own.** The filter used to be JavaScript over rows
   * already read, body and all — so the device that had just pushed a 45 MB import put the
   * whole of it through this isolate again on its own next pull, to have it dropped (measured
   * 2026-10-05). It is `device <> ?` in the query now.
   */
  private pull(url: URL, group: string): Response {
    const rawCursor = url.searchParams.get("since") ?? "0";
    const cursor = Number(rawCursor);
    const device = url.searchParams.get("device") ?? "";
    if (!Number.isFinite(cursor) || cursor < 0) return json({ error: "bad cursor" }, 400);
    const limit = pageLimit(url.searchParams.get("limit"));
    if (limit === "bad") return json({ error: "bad limit" }, 400);

    // **A pull is the relay hearing from a device**, and a device whose cursor is held pulls on
    // every trip without ever acking — see `HEARD_REFRESH_MS` for why that has to count. The
    // `heard_at < ?` makes it a write at most once a day per device, and a device with no ack
    // row — never acked, departed, or aged out — matches nothing: its next ack is what enrols it.
    if (device !== "") {
      const now = Date.now();
      this.sql.exec(
        `UPDATE acks SET heard_at = ? WHERE device = ? AND heard_at < ?`,
        now,
        device,
        now - HEARD_REFRESH_MS,
      );
    }

    return limit === null
      ? this.pullWhole(cursor, device, group)
      : this.pullPage(cursor, device, group, limit);
  }

  /**
   * The head of the whole log as a pull answers it: the highest `seq` there is, and never below
   * the cursor it was asked from.
   *
   * **The whole log's, not the answered rows'.** The answer leaves the caller's own rows out, and
   * a cursor taken from what is left would sit below them — so the device would be asked to read
   * past its own rows on every pull for as long as they survived compaction, and its ack, which
   * follows its cursor, would pin the compaction floor under them.
   */
  private head(cursor: number): number {
    const newest = this.sql
      .exec<{ seq: number }>(`SELECT coalesce(max(seq), 0) AS seq FROM log`)
      .one().seq;
    return Math.max(cursor, newest);
  }

  /**
   * Everything after `cursor`, in the group's own order — **the answer every released build is
   * written against, byte for byte, and streamed**.
   *
   * It was one string: every row read into an array, sorted, and serialised whole, which cost
   * this isolate twice the log in JS heap (89 MB for a 45 MB log, measured 2026-10-05) — inside a
   * 128 MB it shares with every other group. It cannot be capped, for the reason [`pull`] gives.
   * So it is written out as it is read: the order is asked of SQLite over the rows' stamps, with
   * no body read; each row is then read on its own, as the stream is pulled from, and written.
   * What is in memory at once is the list of `seq`s and a chunk on its way out.
   *
   * **The same bytes.** `ORDER BY hlc_ms, hlc_ctr, device, seq` is `log.ts`'s `since`: the
   * group's order, and — where the clock cannot tell two rows apart — the order they were read
   * in, which was `seq`. The body is `JSON.stringify`'s spelling of `{ envelopes, cursor }`,
   * piece by piece. `group.test.ts` holds the two to each other over a fixture log. What does
   * change is what a stream changes: the answer carries no `Content-Length`.
   *
   * **The head is read first and bounds the rest**, so a push that lands while the answer is
   * still being written is not in it and is not stepped over by its cursor either.
   *
   * **A row the list named that has gone by the time it is read is left out, and a compaction
   * can take one.** The stream is pulled from between other requests, and another device's ack
   * runs `compactNow` among them. For a caller that holds the floor — it has an ack row, and
   * asks from its ack or above — nothing it was listed is below the floor, so only a drop or its
   * own departure deletes one, after either of which the answer is nobody's to read. **A caller
   * the relay has never heard from holds no floor**: with no ack row and no row of its own,
   * `log.ts`'s `compact` does not count it — a device replaying from zero, as a join is. Nor
   * does a floor cover a caller asking from below its own ack. Rows either was listed can go
   * mid-stream, behind another device's ack. Only a row both below the floor and older than the
   * thirty-day tail qualifies, and the answer is then the one a pull made a moment later would
   * have had — so it is no loss the compaction had not already decided, and nothing new.
   * **The same holds between two pages of a paged pull** ([`pullPage`]): a page is read in one
   * turn of the object, and a compaction can fall between two of them.
   */
  private pullWhole(cursor: number, device: string, group: string): Response {
    const head = this.head(cursor);
    const order = this.sql
      .exec<{ seq: number }>(
        `SELECT seq FROM log
          WHERE seq > ? AND seq <= ? AND device <> ?
          ORDER BY hlc_ms, hlc_ctr, device, seq`,
        cursor,
        head,
        device,
      )
      .toArray();

    const encoder = new TextEncoder();
    let next = 0;
    let written = false;
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => controller.enqueue(encoder.encode(`{"envelopes":[`)),
      pull: (controller) => {
        // A chunk at a time: rows until about a page's worth is written, then back to the
        // runtime, which asks again when the reader has taken it.
        const parts: string[] = [];
        for (let chars = 0; next < order.length && chars < STREAM_CHUNK_CHARS; next += 1) {
          const row = this.sql
            .exec<LogRow>(
              `SELECT device, epoch, hlc_ms, hlc_ctr, sealed FROM log WHERE seq = ?`,
              order[next].seq,
            )
            .toArray()[0];
          if (row === undefined) continue;
          parts.push((written ? "," : "") + JSON.stringify(envelopeOf(group, row)));
          written = true;
          chars += row.sealed.length;
        }
        if (next >= order.length) parts.push(`],"cursor":${JSON.stringify(head)}}`);
        controller.enqueue(encoder.encode(parts.join("")));
        if (next >= order.length) controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  }

  /**
   * One page: at most `limit` rows after `cursor` **in `seq` order**, whole, inside the relay's
   * own budget of sealed characters ([`pageLength`]) — answered `{ envelopes, cursor, more }`.
   *
   * **`seq` order is what makes a page safe to act on**: it is exactly what a device that pulled
   * when the log's head stood at the page's last row was handed. Within the page the envelopes
   * are in the group's order, as they are in any answer.
   *
   * **The sizes are read before the bodies, and only as far as the page goes.** The first query
   * asks each candidate row's length and no more, a row at a time; the budget decides how many
   * the page takes and stops the asking at the first that does not fit; and the second reads
   * exactly those — so what this isolate holds is the page, and never a row that will not be in
   * it. *A row at a time*, because `limit` is a ceiling a client names in rows — 256 from the
   * app — and SQLite loads a row's text to measure it: asked for all of them at once, every
   * page of a large catch-up measured a hundred and twenty-eight times what it answered
   * (measured 2026-10-05: 30–90 ms a page under workerd, where the page itself is two rows).
   *
   * **`more` is whether a row of another device lies past the page**, asked with `EXISTS`: no
   * body is read to answer it, and the caller's own rows do not count — a page followed only by
   * those is the last.
   *
   * **And the cursor follows from it.** While `more` is true it is the last row answered, and the
   * next page starts after it. When it is false it is the head of the whole log ([`head`]): past
   * the caller's own trailing rows, which no page will ever carry. Stopping at the last row
   * answered there would leave a device that pushed after it pulled acking below its own rows
   * for ever — the compaction floor pinned under them — and a client that goes on while its
   * cursor moves would have nothing to stop on.
   */
  private pullPage(cursor: number, device: string, group: string, limit: number): Response {
    const candidates = this.sql.exec<{ seq: number; chars: number }>(
      `SELECT seq, length(sealed) AS chars FROM log
        WHERE seq > ? AND device <> ?
        ORDER BY seq LIMIT ?`,
      cursor,
      device,
      limit,
    );
    // Each row's `seq`, kept as its size is asked for: `pageLength` stops at the first size
    // that does not fit, and the cursor is read no further than that.
    const seqs: number[] = [];
    const sizes = (function* () {
      for (const row of candidates) {
        seqs.push(row.seq);
        yield row.chars;
      }
    })();
    const taken = pageLength(sizes);
    if (taken === 0) return json({ envelopes: [], cursor: this.head(cursor), more: false });

    const last = seqs[taken - 1];
    const rows = this.sql
      .exec<LogRow>(
        `SELECT device, epoch, hlc_ms, hlc_ctr, sealed FROM log
          WHERE seq > ? AND seq <= ? AND device <> ?
          ORDER BY seq`,
        cursor,
        last,
        device,
      )
      .toArray();
    const more =
      this.sql
        .exec<{ more: number }>(
          `SELECT EXISTS (SELECT 1 FROM log WHERE seq > ? AND device <> ?) AS more`,
          last,
          device,
        )
        .one().more === 1;

    return json({
      envelopes: inGroupOrder(rows.map((row) => envelopeOf(group, row))),
      cursor: more ? last : this.head(cursor),
      more,
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
      .exec<{ cursor: number | null; departed: number }>(
        `SELECT (SELECT cursor FROM acks WHERE device = ?) AS cursor,
                EXISTS (SELECT 1 FROM departed WHERE device = ?) AS departed`,
        body.device,
        body.device,
      )
      .one();

    // **A departed device's ack is answered and not stored.** A removed device holds a token for
    // up to a day after the rotation that removed it, and storing its ack would enrol it back on
    // the floor it was just taken off — with a cursor it will never advance, because it can no
    // longer open anything new. Only a roster that names it again un-departs it. 204 rather than a
    // refusal: the device learns it is out from `/keys`, which is the one answer it acts on.
    if (prior.departed) return new Response(null, { status: 204 });
    const before = prior.cursor ?? -1;

    // `max(...)` and not a plain assignment: an ack is a watermark, and a retry that arrives
    // out of order must not walk a device's cursor backwards into rows it has already folded.
    // `heard_at` is plain: any ack at all is the device being heard.
    this.sql.exec(
      `INSERT INTO acks (device, cursor, heard_at) VALUES (?, ?, ?)
         ON CONFLICT (device) DO UPDATE
           SET cursor = max(acks.cursor, excluded.cursor), heard_at = excluded.heard_at`,
      body.device,
      body.cursor,
      Date.now(),
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
   *
   * It also deletes the acks `compact` says to forget — a departed device's, or one unheard for
   * `ACK_TTL_MS` — and writes back the log's exact size, which is what keeps `log_size` honest
   * (see the constructor). Each row's length is read beside its place in the log, so the size
   * costs no read of its own. It still visits every row — the floor is computed across every
   * device, and a bounded read would compute it against a slice.
   */
  private compactNow(): void {
    const now = Date.now();
    // **Each row's length, and never its body.** What survives is decided by where a row stands,
    // who sent it and when it was stored, and the size written back below is a sum of lengths —
    // none of which needs a `sealed` in this isolate. Read whole, as it was, this pass cost the
    // JS heap the entire log on every ack that moved a cursor: 45 MB for a 45 MB log.
    const rows = this.sql
      .exec<{ seq: number; device: string; stored_at: number; chars: number }>(
        `SELECT seq, device, stored_at, length(sealed) AS chars FROM log`,
      )
      .toArray()
      .map((row) => ({
        seq: row.seq,
        device: row.device,
        storedAt: row.stored_at,
        chars: row.chars,
      }));
    const acks = new Map<string, Ack>();
    for (const ack of this.sql.exec<AckRow>(`SELECT device, cursor, heard_at FROM acks`)) {
      acks.set(ack.device, { cursor: ack.cursor, heardAt: ack.heard_at ?? now });
    }
    const departed = new Set<string>();
    for (const mark of this.sql.exec<{ device: string }>(`SELECT device FROM departed`)) {
      departed.add(mark.device);
    }

    const { keep, forget } = compact(rows, acks, departed, now);
    const kept = new Set(keep.map((row) => row.seq));
    for (const row of rows) {
      if (!kept.has(row.seq)) this.sql.exec(`DELETE FROM log WHERE seq = ?`, row.seq);
    }
    for (const device of forget) this.sql.exec(`DELETE FROM acks WHERE device = ?`, device);

    const chars = keep.reduce((sum, row) => sum + row.chars, 0);
    this.sql.exec(`UPDATE log_size SET chars = ? WHERE id = 1`, chars);
  }

  /**
   * A rotation's manifest, as the object hears of it: `{ devices }` is the key set the group just
   * adopted, and every device this object knows of that it omits has left the group.
   *
   * **Called only by the Worker, after `/rotate` has recorded the rotation in D1** — never by a
   * device, which is why, like `drop`, it is not on the router's public `ROUTE` regex. Without it
   * nothing ever told this object of a removal: `/rotate` is answered out of D1 ahead of the
   * bearer gate and, before this post, never reached here, so a removed device's ack stayed the
   * slowest reader the group had, for good.
   *
   * Each omitted device is marked departed and its ack deleted; each named one loses any mark it
   * had, which is how a device that left and was paired back in holds the floor again. Then a
   * compaction, because the floor has just moved. **The caller is best effort** — a roster that
   * never arrives leaves the old pin in place until `log.ts`'s `ACK_TTL_MS` ages it out, which is
   * the direction that keeps rows.
   *
   * **Posts are applied in epoch order, not arrival order.** The body carries the rotation's
   * epoch, and a roster no newer than the last one applied is answered 204 and changes nothing
   * (`log.isNewerRoster`): each is sent from inside the `/rotate` request that recorded it, so two
   * rotations accepted back to back post two rosters that nothing else orders, and the older one
   * arriving second would otherwise put back a device the newer one removed.
   *
   * `SELECT … UNION` reads the whole log for the senders in it, and the compaction after reads it
   * again. A rotation is a handful of events in a group's life, so the second scan is not worth a
   * shared read to save.
   */
  private async roster(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "unreadable body" }, 400);
    }
    const roster = parseRoster(body);
    if (roster === null) return json({ error: "malformed roster" }, 400);
    const applied = this.sql
      .exec<{ epoch: number }>(`SELECT epoch FROM roster_epoch WHERE id = 1`)
      .toArray();
    if (!isNewerRoster(applied.length > 0 ? applied[0].epoch : null, roster.epoch)) {
      return new Response(null, { status: 204 });
    }
    const named = roster.devices;

    // **A device holding a socket is one this object knows of**, whether or not it has acked or
    // pushed yet — a device removed minutes after it joined has done neither — so it is marked
    // departed with the rest, and its socket is closed below.
    const sockets = this.sockets();
    const connected = sockets
      .map((socket) => taggedDevice(socket.tag))
      .filter((device): device is string => device !== undefined);
    const known = this.sql
      .exec<{ device: string }>(`SELECT device FROM acks UNION SELECT device FROM log`)
      .toArray()
      .map((row) => row.device)
      .concat(connected);
    const now = Date.now();
    for (const device of departures(known, named)) {
      // `DO NOTHING`: a device omitted by two rosters left at the first, and `at` says when.
      this.sql.exec(
        `INSERT INTO departed (device, at) VALUES (?, ?) ON CONFLICT (device) DO NOTHING`,
        device,
        now,
      );
      this.sql.exec(`DELETE FROM acks WHERE device = ?`, device);
    }
    for (const device of named) this.sql.exec(`DELETE FROM departed WHERE device = ?`, device);
    this.sql.exec(
      `INSERT INTO roster_epoch (id, epoch) VALUES (1, ?)
         ON CONFLICT (id) DO UPDATE SET epoch = excluded.epoch`,
      roster.epoch,
    );

    // The floor has just moved. **Before the sockets below**, so nothing a close can do stands
    // between a roster that was applied and the compaction it owes.
    this.compactNow();

    // **And the removed devices are told**, which until 2026-10-04 nothing did: each socket of a
    // device this roster does not name is closed with `CLOSE_REMOVED` — 4002, a code of its own
    // and not the 4001 `drop` closes a whole group with; `log.ts` has why. `removedSockets` is
    // which, and why a rotation that took a device out left it reading *live* before. Read off
    // the same `named` the marks above were, so the two cannot disagree about who left.
    //
    // Best effort, each on its own: a socket that throws on `close` — one the runtime has already
    // torn down — must not leave the next removed device untold, nor turn an applied roster
    // into a 500 its caller would read as not applied.
    for (const gone of removedSockets(sockets, named)) {
      try {
        gone.ws.close(CLOSE_REMOVED, "removed from the group");
      } catch (error) {
        console.error("roster close", error);
      }
    }

    return new Response(null, { status: 204 });
  }

  /** Every socket this object holds, hibernated ones included, as `log.ts` reads one. */
  private sockets(): { ws: WebSocket; tag: string | undefined; open: boolean }[] {
    return this.state.getWebSockets().map((ws) => ({
      ws,
      tag: this.state.getTags(ws)[0],
      open: ws.readyState === WebSocket.OPEN,
    }));
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
    const frame = headFrame(cursor, from);
    for (const target of notifyTargets(this.sockets(), from)) {
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
   *
   * **The 101 selects `grimoire.live.v1` when the request offered it, and only then.** A browser
   * opens this socket with two sub-protocols — that name, and `bearer.<token>`, which the Worker's
   * gate has already read and verified — and fails the connection if the answer selects none. A
   * native client offers none and gets the bare 101 it always got. `ticket.ts`'s `selectedProtocol`
   * is both halves, and why the `bearer.` entry is never what comes back.
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

    // Two literals rather than one with an optional `headers`: the first is byte for byte the
    // response every released desktop has been answered with, and it stays visibly so.
    const protocol = selectedProtocol(request.headers.get("Sec-WebSocket-Protocol"));
    if (protocol === null) return new Response(null, { status: 101, webSocket: client });
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "Sec-WebSocket-Protocol": protocol },
    });
  }

  /**
   * Required so a stray frame is consumed rather than dropped.
   *
   * **A missing or misspelled handler is a silent no-op** — `workerd` drops the message with no
   * error and no log, while still waking the object and still billing the request. That failure
   * reads exactly like "the client is not sending anything", so the handler exists even though
   * nothing is expected to arrive: the client's keepalive is a *protocol* ping, which the
   * runtime answers itself without waking anything and without calling this.
   *
   * **The web app's keepalive does not arrive here either.** A browser can send no protocol ping,
   * so it sends the text `ping` — and the constructor's `setWebSocketAutoResponse` has the runtime
   * answer that with `pong` before this handler is ever asked. A frame that does reach it is
   * therefore neither keepalive: a client bug, or somebody typing at a socket.
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
   * floor derived from cursors into a log that no longer exists. `log_size` goes to zero with the
   * log it measures.
   *
   * **`departed` is kept, and that is the one table the drop leaves.** A membership ending does
   * not un-pair anybody: the devices that left the group are still gone from it, and a reader who
   * resubscribes is resubscribing the same group with the same devices missing.
   */
  private drop(): Response {
    this.sql.exec(`DELETE FROM log`);
    this.sql.exec(`DELETE FROM acks`);
    this.sql.exec(`UPDATE log_size SET chars = 0 WHERE id = 1`);
    // 4001 is in the private range, so the Rust client can tell "this group was dropped" from
    // any transport-level close — and from 4002, which is one device taken off a manifest
    // (`log.ts`'s `CLOSE_REMOVED`). There is no close-all API; the loop is it. `state.abort()`
    // would also do it and is the wrong tool — it logs an error application code cannot catch.
    for (const ws of this.state.getWebSockets()) {
      ws.close(CLOSE_DROPPED, "group dropped");
    }
    return new Response(null, { status: 204 });
  }
}
