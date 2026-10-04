import { afterEach, describe, expect, it, vi } from "vitest";
import { Group } from "./group";
import { CLOSE_REMOVED, deviceTag } from "./log";

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

interface FakeSocket {
  readyState: number;
  tags: string[];
  close: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
}

function socket(device: string | null, readyState: number = WebSocket.OPEN): FakeSocket {
  return {
    readyState,
    tags: device === null ? [] : [deviceTag(device)],
    close: vi.fn(),
    send: vi.fn(),
  };
}

/**
 * Just enough of a `DurableObjectState` for the constructor, `roster()` and the compaction
 * behind it.
 *
 * **The SQL is answered by what the statement says and is not a fake of SQLite**: the
 * constructor's two probes find what stops its migrations, the roster's reads answer `stored`,
 * and every write is kept as text and arguments, which is what the tests below read.
 */
function fakeState(sockets: FakeSocket[], stored: { epoch?: number; known?: string[] } = {}) {
  const written: { sql: string; args: unknown[] }[] = [];
  const rows = (sql: string): Record<string, unknown>[] => {
    if (sql.includes("PRAGMA table_info(acks)")) return [{ name: "heard_at" }];
    if (sql.includes("SELECT 1 FROM log_size")) return [{ 1: 1 }];
    if (sql.includes("FROM roster_epoch")) {
      return stored.epoch === undefined ? [] : [{ epoch: stored.epoch }];
    }
    if (sql.includes("SELECT device FROM acks UNION SELECT device FROM log")) {
      return (stored.known ?? []).map((device) => ({ device }));
    }
    return [];
  };
  const exec = (sql: string, ...args: unknown[]) => {
    const text = sql.replace(/\s+/g, " ").trim();
    if (/^(INSERT|UPDATE|DELETE)/.test(text)) written.push({ sql: text, args });
    const answer = rows(text);
    return {
      toArray: () => answer,
      one: () => answer[0],
      [Symbol.iterator]: () => answer[Symbol.iterator](),
    };
  };
  const state = {
    id: { name: "g1" },
    storage: { sql: { exec } },
    setWebSocketAutoResponse: () => undefined,
    acceptWebSocket: () => undefined,
    getWebSockets: () => sockets,
    getTags: (ws: FakeSocket) => ws.tags,
  };
  return { state: state as unknown as DurableObjectState, written };
}

/** The one workerd global the constructor reaches for. */
function stubWorkerd(): void {
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

  it("closes a removed device's socket with 4001, and nobody else's", async () => {
    stubWorkerd();
    const desk = socket("desk");
    const phone = socket("phone");
    const { state } = fakeState([desk, phone], { known: ["desk", "phone"] });

    const response = await new Group(state).fetch(roster(2, ["desk"]));

    expect(response.status).toBe(204);
    expect(phone.close).toHaveBeenCalledTimes(1);
    expect(phone.close).toHaveBeenCalledWith(CLOSE_REMOVED, "removed from the group");
    expect(CLOSE_REMOVED).toBe(4001);
    expect(desk.close).not.toHaveBeenCalled();
    // A close, and nothing sent: a removed device is owed no frame about a log it cannot read.
    expect(phone.send).not.toHaveBeenCalled();
  });

  it("marks a device departed that it knows only by its socket", async () => {
    // Removed minutes after it joined: it has pushed nothing and acked nothing, so the log and
    // the acks have never heard of it — and it is holding a socket.
    stubWorkerd();
    const phone = socket("phone");
    const { state, written } = fakeState([socket("desk"), phone], { known: ["desk"] });

    await new Group(state).fetch(roster(2, ["desk"]));

    expect(departed(written)).toEqual(["phone"]);
    expect(phone.close).toHaveBeenCalledWith(CLOSE_REMOVED, "removed from the group");
  });

  it("closes the leaver's own socket: a departure is a manifest without it", async () => {
    stubWorkerd();
    const last = socket("desk");
    const { state } = fakeState([last], { known: ["desk"] });

    await new Group(state).fetch(roster(3, []));

    expect(last.close).toHaveBeenCalledWith(CLOSE_REMOVED, "removed from the group");
  });

  it("closes nobody for a roster that names every device it holds a socket for", async () => {
    // A join: the manifest grew. Both sockets stay, the new device's included.
    stubWorkerd();
    const sockets = [socket("desk"), socket("phone")];
    const { state, written } = fakeState(sockets, { known: ["desk"] });

    await new Group(state).fetch(roster(1, ["desk", "phone"]));

    for (const each of sockets) expect(each.close).not.toHaveBeenCalled();
    expect(departed(written)).toEqual([]);
  });

  it("closes nobody for a roster no newer than the last it applied", async () => {
    // A post that lost a race to a newer rotation's must not undo it — nor hang up on a device
    // the newer one put back.
    stubWorkerd();
    const phone = socket("phone");
    const { state, written } = fakeState([phone], { epoch: 4, known: ["phone"] });

    const response = await new Group(state).fetch(roster(4, []));

    expect(response.status).toBe(204);
    expect(phone.close).not.toHaveBeenCalled();
    expect(written).toEqual([]);
  });

  it("closes nobody for a body it cannot read as a roster", async () => {
    stubWorkerd();
    const phone = socket("phone");
    const { state } = fakeState([phone], { known: ["phone"] });

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
    const { state } = fakeState([closing, untagged]);

    await new Group(state).fetch(roster(2, ["desk"]));

    expect(closing.close).not.toHaveBeenCalled();
    expect(untagged.close).not.toHaveBeenCalled();
  });

  it("still closes every socket when the whole group is dropped", async () => {
    stubWorkerd();
    const sockets = [socket("desk"), socket("phone")];
    const { state } = fakeState(sockets);

    await new Group(state).fetch(
      new Request("https://relay.internal/g/g1/drop", { method: "POST" }),
    );

    for (const each of sockets) {
      expect(each.close).toHaveBeenCalledWith(CLOSE_REMOVED, "group dropped");
    }
  });
});
