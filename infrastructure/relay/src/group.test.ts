import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeState, stubWorkerd, type FakeSocket, type FakeState } from "./fakeState";
import { Group, type Envelope } from "./group";
import {
  CLOSE_DROPPED,
  CLOSE_REMOVED,
  deviceTag,
  MAX_GROUP_LOG_CHARS,
  pageLength,
  pageLimit,
  PULL_LIMIT_MAX,
  PULL_PAGE_CHARS,
  since,
  TAIL_MS,
  type Row,
} from "./log";

/**
 * **A rotation's roster tells the devices it took out** (light app phase 6, step 6.3b): the real
 * `Group`, over a stand-in for the Durable Object's state, as `ticket.test.ts` drives its `ws()`.
 *
 * Which sockets is `log.ts`'s `removedSockets`, tested there as a function. What is here is that
 * the object *calls* it — with the roster it was posted and the sockets it holds — and closes
 * what it answers, with the code a client reads as removed; that a roster the object refuses
 * closes nobody; and that a device holding a socket is marked departed with the ones that have
 * acked.
 */

function socket(device: string | null, readyState: number = WebSocket.OPEN): FakeSocket {
  return {
    readyState,
    tags: device === null ? [] : [deviceTag(device)],
    close: vi.fn(),
    send: vi.fn(),
  };
}

/**
 * A group that has `stored` and holds `sockets`: the shared stand-in (`fakeState.ts`) over
 * SQLite, with the object's own tables made by its constructor and `stored` written into them
 * — the last roster's epoch, and the devices the object has heard an ack from.
 *
 * `written()` is every statement that wrote a row since then, which is what a roster did.
 * (These tests had a stand-in of their own, answering SQL by what a statement said; it went
 * when step 6.5b put SQLite behind the one `ticket.test.ts` uses, so there is one.)
 */
function group(sockets: FakeSocket[], stored: { epoch?: number; known?: string[] } = {}) {
  const fake = fakeState("sqlite", sockets);
  new Group(fake.state);
  if (stored.epoch !== undefined) {
    fake.sql(`INSERT INTO roster_epoch (id, epoch) VALUES (1, ?)`, stored.epoch);
  }
  for (const device of stored.known ?? []) {
    fake.sql(`INSERT INTO acks (device, cursor, heard_at) VALUES (?, 0, ?)`, device, Date.now());
  }
  const from = fake.asked.length;
  return {
    state: fake.state,
    written: () => fake.written(from).map((one) => ({ sql: one.query, args: one.bindings })),
  };
}

/** The internal post `rotate.ts` makes once a rotation is recorded. */
function roster(epoch: number, devices: string[]): Request {
  return new Request("https://relay.internal/g/g1/roster", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ epoch, devices }),
  });
}

const departed = (written: { sql: string; args: unknown[] }[]) =>
  written.filter((w) => w.sql.startsWith("INSERT INTO departed")).map((w) => w.args[0]);

describe("a roster, and the sockets of the devices it leaves out", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("closes a removed device's socket with 4002, and nobody else's", async () => {
    stubWorkerd();
    const desk = socket("desk");
    const phone = socket("phone");
    const { state } = group([desk, phone], { known: ["desk", "phone"] });

    const response = await new Group(state).fetch(roster(2, ["desk"]));

    expect(response.status).toBe(204);
    expect(phone.close).toHaveBeenCalledTimes(1);
    expect(phone.close).toHaveBeenCalledWith(CLOSE_REMOVED, "removed from the group");
    // Never the dropped group's 4001: a released client reads that as "the group no longer
    // exists", and a new one as a lapse.
    expect(CLOSE_REMOVED).toBe(4002);
    expect(desk.close).not.toHaveBeenCalled();
    // A close, and nothing sent: a removed device is owed no frame about a log it cannot read.
    expect(phone.send).not.toHaveBeenCalled();
  });

  it("marks a device departed that it knows only by its socket", async () => {
    // Removed minutes after it joined: it has pushed nothing and acked nothing, so the log and
    // the acks have never heard of it — and it is holding a socket.
    stubWorkerd();
    const phone = socket("phone");
    const { state, written } = group([socket("desk"), phone], { known: ["desk"] });

    await new Group(state).fetch(roster(2, ["desk"]));

    expect(departed(written())).toEqual(["phone"]);
    expect(phone.close).toHaveBeenCalledWith(CLOSE_REMOVED, "removed from the group");
  });

  it("closes the leaver's own socket: a departure is a manifest without it", async () => {
    stubWorkerd();
    const last = socket("desk");
    const { state } = group([last], { known: ["desk"] });

    await new Group(state).fetch(roster(3, []));

    expect(last.close).toHaveBeenCalledWith(CLOSE_REMOVED, "removed from the group");
  });

  it("closes nobody for a roster that names every device it holds a socket for", async () => {
    // A join: the manifest grew. Both sockets stay, the new device's included.
    stubWorkerd();
    const sockets = [socket("desk"), socket("phone")];
    const { state, written } = group(sockets, { known: ["desk"] });

    await new Group(state).fetch(roster(1, ["desk", "phone"]));

    for (const each of sockets) expect(each.close).not.toHaveBeenCalled();
    expect(departed(written())).toEqual([]);
  });

  it("closes nobody for a roster no newer than the last it applied", async () => {
    // A post that lost a race to a newer rotation's must not undo it — nor hang up on a device
    // the newer one put back.
    stubWorkerd();
    const phone = socket("phone");
    const { state, written } = group([phone], { epoch: 4, known: ["phone"] });

    const response = await new Group(state).fetch(roster(4, []));

    expect(response.status).toBe(204);
    expect(phone.close).not.toHaveBeenCalled();
    expect(written()).toEqual([]);
  });

  it("closes nobody for a body it cannot read as a roster", async () => {
    stubWorkerd();
    const phone = socket("phone");
    const { state } = group([phone], { known: ["phone"] });

    const response = await new Group(state).fetch(
      new Request("https://relay.internal/g/g1/roster", { method: "POST", body: "{}" }),
    );

    expect(response.status).toBe(400);
    expect(phone.close).not.toHaveBeenCalled();
  });

  it("leaves a socket that is already closing, and one with no tag", async () => {
    stubWorkerd();
    const closing = socket("phone", WebSocket.CLOSING);
    const untagged = socket(null);
    const { state } = group([closing, untagged]);

    await new Group(state).fetch(roster(2, ["desk"]));

    expect(closing.close).not.toHaveBeenCalled();
    expect(untagged.close).not.toHaveBeenCalled();
  });

  it("a socket that throws on close leaves the roster applied and the rest told", async () => {
    // One the runtime tore down between the listing and the close. The roster is recorded and
    // compacted, the next removed device is still told, and the answer is still the 204 its
    // caller reads as applied.
    stubWorkerd();
    const torn = socket("phone");
    torn.close.mockImplementation(() => {
      throw new Error("the socket is gone");
    });
    const tablet = socket("tablet");
    const { state, written } = group([torn, tablet], { known: ["desk", "phone", "tablet"] });
    const said = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await new Group(state).fetch(roster(2, ["desk"]));

    expect(response.status).toBe(204);
    expect(tablet.close).toHaveBeenCalledWith(CLOSE_REMOVED, "removed from the group");
    expect(written().some((w) => w.sql.startsWith("INSERT INTO roster_epoch"))).toBe(true);
    expect(said).toHaveBeenCalledTimes(1);
    said.mockRestore();
  });

  it("still closes every socket when the whole group is dropped — with 4001, as it always has", async () => {
    stubWorkerd();
    const sockets = [socket("desk"), socket("phone")];
    const { state } = group(sockets);

    await new Group(state).fetch(
      new Request("https://relay.internal/g/g1/drop", { method: "POST" }),
    );

    for (const each of sockets) {
      expect(each.close).toHaveBeenCalledWith(CLOSE_DROPPED, "group dropped");
      expect(each.close).not.toHaveBeenCalledWith(CLOSE_REMOVED, expect.anything());
    }
    expect(CLOSE_DROPPED).toBe(4001);
  });
});

/**
 * The Durable Object's own half of a pull, a push and an ack, over SQLite (light app phase 6,
 * step 6.5b — the pull is paged).
 *
 * `log.test.ts` holds the pure decisions. What is here is what was never tested because it could
 * not be: the statements. Every rule paging adds is a clause — which rows a page takes, where its
 * cursor stands, whether more lie past it — and so is what the same step takes *out* of the
 * object's memory: a caller's own rows, and every body a compaction used to read.
 * `fakeState("sqlite")` runs them for real and keeps what each one read.
 */

const GROUP = "g1";

interface Relay extends FakeState {
  object: Group;
  /** Store one row as `device`, stamped `hlcMs`; answers its `seq`. */
  push: (device: string, sealed: string, hlcMs: number, hlcCtr?: number) => Promise<number>;
  /** A pull, as its query string; answers the status, the parsed body and the body's text. */
  pull: (query: string) => Promise<{ status: number; text: string; body: Answer }>;
  ack: (device: string, cursor: number) => Promise<number>;
  /** The `sealed` characters read into the object since `mark` (a length of `asked`). */
  bodiesSince: (mark: number) => number;
}

interface Answer {
  envelopes: Envelope[];
  cursor: number;
  more?: boolean;
  error?: string;
}

function relay(): Relay {
  const fake = fakeState("sqlite");
  const object = new Group(fake.state);
  const at = (path: string) => `https://relay.example/g/${GROUP}/${path}`;
  return {
    ...fake,
    object,
    async push(device, sealed, hlcMs, hlcCtr = 0) {
      const envelope: Envelope = { group: GROUP, device, epoch: 1, hlcMs, hlcCtr, sealed };
      const response = await object.fetch(
        new Request(at("push"), { method: "POST", body: JSON.stringify(envelope) }),
      );
      expect(response.status).toBe(200);
      return ((await response.json()) as { cursor: number }).cursor;
    },
    async pull(query) {
      const response = await object.fetch(new Request(at(`pull?${query}`)));
      const text = await response.text();
      return { status: response.status, text, body: JSON.parse(text) as Answer };
    },
    async ack(device, cursor) {
      const response = await object.fetch(
        new Request(at("ack"), { method: "POST", body: JSON.stringify({ device, cursor }) }),
      );
      return response.status;
    },
    bodiesSince: (mark) =>
      fake.asked.slice(mark).reduce((sum, statement) => sum + statement.sealedChars, 0),
  };
}

/** What a page answered, as `device@hlcMs` in the order it answered them. */
const said = (answer: Answer) => answer.envelopes.map((e) => `${e.device}@${e.hlcMs}`);

beforeEach(() => stubWorkerd());
afterEach(() => vi.unstubAllGlobals());

describe("a pull that names a limit", () => {
  it("takes rows in seq order, answers them in the group's order, and says whether more lie past them", async () => {
    const r = relay();
    // Arrival order and clock order are opposite: seq 1 is the newest stamp.
    for (const hlcMs of [50, 40, 30, 20, 10]) await r.push("b", `s${hlcMs}`, hlcMs);

    const first = (await r.pull("since=0&device=a&limit=2")).body;
    // Rows 1 and 2 — the first two to *arrive* — and within the page, the clock's order.
    expect(said(first)).toEqual(["b@40", "b@50"]);
    expect(first).toMatchObject({ cursor: 2, more: true });

    const second = (await r.pull(`since=${first.cursor}&device=a&limit=2`)).body;
    expect(said(second)).toEqual(["b@20", "b@30"]);
    expect(second).toMatchObject({ cursor: 4, more: true });

    const last = (await r.pull(`since=${second.cursor}&device=a&limit=2`)).body;
    expect(said(last)).toEqual(["b@10"]);
    expect(last).toMatchObject({ cursor: 5, more: false });
  });

  it("spells an envelope as every answer has: six fields, in one order", async () => {
    const r = relay();
    await r.push("b", "sealed-text", 7, 3);

    const { text } = await r.pull("since=0&device=a&limit=1");

    expect(text).toBe(
      `{"envelopes":[{"group":"g1","device":"b","epoch":1,"hlcMs":7,"hlcCtr":3,"sealed":"sealed-text"}],"cursor":1,"more":false}`,
    );
  });

  it("leaves the caller's own rows out in the query, and reads none of them", async () => {
    const r = relay();
    const mine = "m".repeat(5_000);
    await r.push("b", "b-one", 1);
    await r.push("a", mine, 2);
    await r.push("a", mine, 3);
    await r.push("b", "b-four", 4);
    await r.push("a", mine, 5);
    const mark = r.asked.length;

    const first = (await r.pull("since=0&device=a&limit=1")).body;
    expect(said(first)).toEqual(["b@1"]);
    // More: row 4 is another device's. Rows 2 and 3 are not what makes it so.
    expect(first).toMatchObject({ cursor: 1, more: true });

    const second = (await r.pull("since=1&device=a&limit=1")).body;
    // The page is one row and it is row 4: the two of its own before it were stepped over.
    expect(said(second)).toEqual(["b@4"]);
    // And 15 000 characters of this device's own were never brought into the object.
    expect(r.bodiesSince(mark)).toBe("b-one".length + "b-four".length);
    return second;
  });

  it("answers the head of the whole log on the last page, past the caller's own trailing rows", async () => {
    const r = relay();
    await r.push("b", "theirs", 1);
    await r.push("a", "mine", 2);
    await r.push("a", "mine", 3);

    const page = (await r.pull("since=0&device=a&limit=10")).body;

    expect(said(page)).toEqual(["b@1"]);
    // Not 1, the last row answered: a cursor there would have this device acking below its own
    // rows for ever, the compaction floor pinned under them, and asking again on every trip.
    expect(page).toMatchObject({ cursor: 3, more: false });
  });

  it("answers a log that is all the caller's own with nothing, its head, and no more", async () => {
    const r = relay();
    for (const hlcMs of [1, 2, 3]) await r.push("a", "x".repeat(1_000), hlcMs);
    const mark = r.asked.length;

    const page = (await r.pull("since=0&device=a&limit=5")).body;

    expect(page).toEqual({ envelopes: [], cursor: 3, more: false });
    expect(r.bodiesSince(mark)).toBe(0);
  });

  it("never answers a cursor below the one it was asked from", async () => {
    const r = relay();
    await r.push("b", "x", 1);

    expect((await r.pull("since=10&device=a&limit=5")).body).toEqual({
      envelopes: [],
      cursor: 10,
      more: false,
    });
  });

  it("is exact about more at the page's edge", async () => {
    const r = relay();
    await r.push("b", "x", 1);
    await r.push("b", "x", 2);
    // Exactly a page of them, and nothing past it.
    expect((await r.pull("since=0&device=a&limit=2")).body).toMatchObject({
      cursor: 2,
      more: false,
    });

    // A row of the caller's own past the edge is not more — and the cursor passes it.
    await r.push("a", "x", 3);
    expect((await r.pull("since=0&device=a&limit=2")).body).toMatchObject({
      cursor: 3,
      more: false,
    });

    // A row of another device's is.
    await r.push("c", "x", 4);
    expect((await r.pull("since=0&device=a&limit=2")).body).toMatchObject({
      cursor: 2,
      more: true,
    });
  });

  it("holds a page to the relay's own budget whatever limit says, in whole rows", async () => {
    const r = relay();
    const third = "x".repeat(Math.floor(PULL_PAGE_CHARS / 3));
    // Four rows of a third of the budget each: three fit, and the fourth would cross it.
    for (const hlcMs of [1, 2, 3, 4]) await r.push("b", third, hlcMs);
    const mark = r.asked.length;

    const page = (await r.pull("since=0&device=a&limit=1000")).body;

    expect(page.envelopes).toHaveLength(3);
    expect(page).toMatchObject({ cursor: 3, more: true });
    // Whole rows, and only the page's: the fourth row's body was never read.
    expect(page.envelopes.every((e) => e.sealed === third)).toBe(true);
    expect(r.bodiesSince(mark)).toBe(3 * third.length);
  });

  it("measures no further into the log than the page goes", async () => {
    // `limit` is a ceiling a client names in rows — 256, from the app — and SQLite loads a
    // row's text to say how long it is. Twelve rows of a third of the budget: a page is three,
    // and the fourth is the one whose size ends it.
    const r = relay();
    const third = "x".repeat(Math.floor(PULL_PAGE_CHARS / 3));
    for (let hlcMs = 1; hlcMs <= 12; hlcMs += 1) await r.push("b", third, hlcMs);
    const mark = r.asked.length;

    const page = (await r.pull("since=0&device=a&limit=256")).body;

    expect(page.envelopes).toHaveLength(3);
    const sized = r.asked.slice(mark).filter((one) => one.query.includes("length(sealed)"));
    expect(sized).toHaveLength(1);
    expect(sized[0].rows).toBe(4);
  });

  it("always admits one row, however far past the budget it is", async () => {
    const r = relay();
    const fat = "x".repeat(PULL_PAGE_CHARS * 2);
    await r.push("b", fat, 1);
    await r.push("b", "small", 2);

    const first = (await r.pull("since=0&device=a&limit=50")).body;
    expect(first.envelopes.map((e) => e.sealed.length)).toEqual([fat.length]);
    expect(first).toMatchObject({ cursor: 1, more: true });

    // And a row that follows a small one goes to the next page whole, not in part.
    const r2 = relay();
    await r2.push("b", "small", 1);
    await r2.push("b", fat, 2);
    const page = (await r2.pull("since=0&device=a&limit=50")).body;
    expect(page.envelopes.map((e) => e.sealed)).toEqual(["small"]);
    expect(page).toMatchObject({ cursor: 1, more: true });
  });

  it("refuses a limit that is not a whole number of at least one, and never reads it as none", async () => {
    const r = relay();
    await r.push("b", "x", 1);

    for (const limit of ["0", "-1", "1.5", "abc", "", "1e3", " 2"]) {
      const answer = await r.pull(`since=0&device=a&limit=${encodeURIComponent(limit)}`);
      expect(answer.status, limit).toBe(400);
      expect(answer.body, limit).toEqual({ error: "bad limit" });
    }
  });
});

describe("pageLimit and pageLength", () => {
  it("reads no limit as an unpaged pull, and caps one that asks for too many rows", () => {
    expect(pageLimit(null)).toBeNull();
    expect(pageLimit("1")).toBe(1);
    expect(pageLimit("256")).toBe(256);
    expect(pageLimit(String(PULL_LIMIT_MAX + 1))).toBe(PULL_LIMIT_MAX);
    expect(pageLimit("999999999")).toBe(PULL_LIMIT_MAX);
    expect(pageLimit("9999999999")).toBe("bad");
  });

  it("takes rows while they fit, the first whatever its size, and stops at the first that does not", () => {
    expect(pageLength([])).toBe(0);
    expect(pageLength([PULL_PAGE_CHARS])).toBe(1);
    expect(pageLength([PULL_PAGE_CHARS + 1, 1])).toBe(1);
    expect(pageLength([PULL_PAGE_CHARS - 1, 1, 1])).toBe(2);
    // A row that does not fit ends the page even when a smaller one behind it would.
    expect(pageLength([10, PULL_PAGE_CHARS, 10])).toBe(1);
  });
});

/**
 * What `pull` answered before step 6.5b, kept here as the thing the unpaged answer is held to:
 * every row past the cursor read whole, the caller's own filtered out in JavaScript, the rest
 * sorted, and all of it serialised as one string.
 */
function asItWasAnswered(r: Relay, cursor: number, device: string): string {
  const rows: Row[] = r
    .sql(
      `SELECT seq, device, epoch, hlc_ms, hlc_ctr, sealed, stored_at FROM log WHERE seq > ?`,
      cursor,
    )
    .map((row) => ({
      seq: row.seq as number,
      device: row.device as string,
      epoch: row.epoch as number,
      hlcMs: row.hlc_ms as number,
      hlcCtr: row.hlc_ctr as number,
      sealed: row.sealed as string,
      storedAt: row.stored_at as number,
    }));
  const head = rows.reduce((max, row) => Math.max(max, row.seq), cursor);
  return JSON.stringify({
    envelopes: since(rows, cursor, device).map((row) => ({
      group: GROUP,
      device: row.device,
      epoch: row.epoch,
      hlcMs: row.hlcMs,
      hlcCtr: row.hlcCtr,
      sealed: row.sealed,
    })),
    cursor: head,
  });
}

describe("a pull that names no limit — every released desktop's", () => {
  /** A log that leans on every tie the order has to break, with own rows through it. */
  async function fixture(): Promise<Relay> {
    const r = relay();
    await r.push("b", "b-late", 900);
    await r.push("a", "mine-1", 100);
    await r.push("c", "c-tie", 500, 2);
    await r.push("b", "b-tie", 500, 2); // the same stamp as the row before: the device decides
    await r.push("b", "b-tie-again", 500, 2); // and the same device: arrival decides
    await r.push("c", "c-early", 100, 9);
    await r.push("a", "mine-2", 950);
    await r.push("c", 'quoted "text" \\ and\nunicode é', 500, 1);
    await r.push("a", "mine-3", 960);
    return r;
  }

  it("is answered byte for byte as it was, from every cursor and for every caller", async () => {
    const r = await fixture();

    for (const device of ["a", "b", "c", "nobody", ""]) {
      for (const cursor of [0, 1, 4, 8, 9, 20]) {
        const query = `since=${cursor}` + (device === "" ? "" : `&device=${device}`);
        const answer = await r.pull(query);
        expect(answer.status).toBe(200);
        expect(answer.text, query).toBe(asItWasAnswered(r, cursor, device));
        // No `more`: an answer with none is the whole of it, which is how a pager reads it too.
        expect(answer.body.more, query).toBeUndefined();
      }
    }
  });

  it("answers an empty log as it always did", async () => {
    const r = relay();
    expect((await r.pull("since=0&device=a")).text).toBe(`{"envelopes":[],"cursor":0}`);
    expect((await r.pull("")).text).toBe(`{"envelopes":[],"cursor":0}`);
  });

  it("is never capped: a log many pages long is answered whole", async () => {
    const r = relay();
    const row = "x".repeat(Math.floor(PULL_PAGE_CHARS / 2));
    for (let n = 1; n <= 9; n += 1) await r.push("b", row, n);

    const answer = await r.pull("since=0&device=a");

    expect(answer.body.envelopes).toHaveLength(9);
    expect(answer.body.cursor).toBe(9);
    expect(answer.text).toBe(asItWasAnswered(r, 0, "a"));
  });

  it("is written out as it is read: no statement brings in more than a chunk and a row", async () => {
    const r = relay();
    const row = "x".repeat(Math.floor(PULL_PAGE_CHARS / 2));
    for (let n = 1; n <= 9; n += 1) await r.push("b", row, n);
    await r.push("a", "y".repeat(PULL_PAGE_CHARS), 10);
    const mark = r.asked.length;

    const response = await r.object.fetch(
      new Request(`https://relay.example/g/${GROUP}/pull?since=0&device=a`),
    );
    const reader = response.body!.getReader();
    let chunks = 0;
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks += 1;
      bytes += value.length;
    }

    // Several chunks, not one string; and each row read on its own, the caller's own never.
    expect(chunks).toBeGreaterThan(3);
    expect(bytes).toBeGreaterThan(9 * row.length);
    const reads = r.asked.slice(mark).filter((statement) => statement.sealedChars > 0);
    expect(reads).toHaveLength(9);
    expect(Math.max(...reads.map((statement) => statement.sealedChars))).toBe(row.length);
  });

  it("answers the log as it stood when the pull was made: a push that lands mid-answer is the next pull's", async () => {
    const r = relay();
    const row = "x".repeat(PULL_PAGE_CHARS);
    for (let n = 1; n <= 4; n += 1) await r.push("b", row, n);

    const response = await r.object.fetch(
      new Request(`https://relay.example/g/${GROUP}/pull?since=0&device=a`),
    );
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = decoder.decode((await reader.read()).value, { stream: true });
    // The answer is under way, and another device pushes.
    await r.push("c", "landed-mid-answer", 5);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }

    const answer = JSON.parse(text) as Answer;
    expect(answer.envelopes).toHaveLength(4);
    expect(answer.cursor).toBe(4);
    // Not stepped over: it is past the cursor that answer handed back.
    expect(said((await r.pull("since=4&device=a")).body)).toEqual(["c@5"]);
  });
});

describe("an ack's compaction, and a full log's", () => {
  it("decides what survives and writes the log's size without reading one body", async () => {
    const r = relay();
    const body = "x".repeat(10_000);
    for (const n of [1, 2, 3, 4]) await r.push("b", body + n, n);
    // Rows 1 and 2 are older than the thirty-day tail; both devices will have acked them.
    r.sql(`UPDATE log SET stored_at = ? WHERE seq <= 2`, Date.now() - TAIL_MS - 60_000);
    expect(await r.ack("a", 4)).toBe(204);
    const mark = r.asked.length;

    // The ack that moves `b`'s cursor past them is the one that compacts.
    expect(await r.ack("b", 4)).toBe(204);

    expect(r.sql(`SELECT seq FROM log ORDER BY seq`).map((row) => row.seq)).toEqual([3, 4]);
    expect(r.sql(`SELECT chars FROM log_size`)[0].chars).toBe(2 * (body.length + 1));
    // The whole of it, with no `sealed` in the object: 40 000 characters decided by length.
    expect(r.bodiesSince(mark)).toBe(0);
    expect(r.asked.slice(mark).some((statement) => /length\(sealed\)/.test(statement.query))).toBe(
      true,
    );
  });

  it("compacts before it refuses a push for the quota, again by length", async () => {
    const r = relay();
    const body = "x".repeat(1_000);
    await r.push("b", body, 1);
    r.sql(`UPDATE log SET stored_at = ?`, Date.now() - TAIL_MS - 60_000);
    await r.ack("a", 1);
    // The running total says the log is full; what is stored says it is a thousand characters.
    r.sql(`UPDATE log_size SET chars = ?`, MAX_GROUP_LOG_CHARS);
    const mark = r.asked.length;

    await r.push("b", "after-the-compaction", 2);

    // Admitted, because the pass that ran first measured the log rather than trusting the total
    // — and it read the one body it stored, which is its own, and no other.
    expect(r.sql(`SELECT chars FROM log_size`)[0].chars).toBe(
      body.length + "after-the-compaction".length,
    );
    expect(r.bodiesSince(mark)).toBe(0);
  });
});

describe("a pull is the relay hearing from a device, paged or not", () => {
  it("refreshes a stale heard_at on either kind of pull", async () => {
    for (const query of ["since=0&device=a", "since=0&device=a&limit=5"]) {
      const r = relay();
      await r.ack("a", 0);
      r.sql(`UPDATE acks SET heard_at = 1 WHERE device = 'a'`);

      await r.pull(query);

      expect(
        r.sql(`SELECT heard_at FROM acks WHERE device = 'a'`)[0].heard_at,
        query,
      ).toBeGreaterThan(1);
    }
  });
});
