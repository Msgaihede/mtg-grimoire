import { describe, expect, it } from "vitest";
import { MAX_GROUP_DEVICES } from "./groupauth";
import {
  ACK_TTL_MS,
  compact,
  CLOSE_DROPPED,
  CLOSE_REMOVED,
  departures,
  deviceTag,
  headFrame,
  notifyTargets,
  isNewerRoster,
  parseRoster,
  removedSockets,
  taggedDevice,
  since,
  TAIL_MS,
  type Ack,
  type Row,
} from "./log";

/**
 * A row with sensible defaults. `hlcMs` follows `seq` unless a test says otherwise, so a test
 * about ordering has to state the disagreement it is testing rather than get it by accident.
 */
function row(over: Partial<Row> & Pick<Row, "seq">): Row {
  return {
    device: "alpha",
    epoch: 1,
    hlcMs: over.seq * 1000,
    hlcCtr: 0,
    sealed: `sealed-${over.seq}`,
    storedAt: 0,
    ...over,
  };
}

const DAY = 24 * 60 * 60 * 1000;

describe("since", () => {
  it("returns nothing for a cursor already at the head", () => {
    const rows = [row({ seq: 1 }), row({ seq: 2 }), row({ seq: 3 })];

    expect(since(rows, 3, "beta")).toEqual([]);
  });

  it("excludes the puller's own rows", () => {
    // A device must not re-apply what it wrote: its own ops are already in its database, and
    // handing them back would make a pull look like a peer's edit.
    const rows = [
      row({ seq: 1, device: "alpha" }),
      row({ seq: 2, device: "beta" }),
      row({ seq: 3, device: "alpha" }),
    ];

    expect(since(rows, 0, "alpha").map((r) => r.seq)).toEqual([2]);
    expect(since(rows, 0, "beta").map((r) => r.seq)).toEqual([1, 3]);
  });

  it("orders by the hybrid logical clock and not by arrival", () => {
    // Arrival says 1 then 2; the clock says the second one happened first. The relay hands
    // them over in the group's order, which every device agrees on, not in the network's.
    const early = row({ seq: 2, device: "beta", hlcMs: 100 });
    const late = row({ seq: 1, device: "alpha", hlcMs: 900 });

    const out = since([late, early], 0, "gamma");

    expect(out.map((r) => r.seq)).toEqual([2, 1]);
    expect(out.map((r) => r.hlcMs)).toEqual([100, 900]);
  });

  it("breaks an identical clock on the device id, so every device sorts the same way", () => {
    const b = row({ seq: 1, device: "beta", hlcMs: 500, hlcCtr: 7 });
    const a = row({ seq: 2, device: "alpha", hlcMs: 500, hlcCtr: 7 });

    expect(since([b, a], 0, "gamma").map((r) => r.device)).toEqual(["alpha", "beta"]);
    expect(since([a, b], 0, "gamma").map((r) => r.device)).toEqual(["alpha", "beta"]);
  });

  it("does not mutate the array it was handed", () => {
    const rows = [row({ seq: 1, hlcMs: 900 }), row({ seq: 2, hlcMs: 100 })];

    since(rows, 0, "gamma");

    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
  });
});

/** An ack at `cursor`, heard at `heardAt`. */
function acked(cursor: number, heardAt: number): Ack {
  return { cursor, heardAt };
}

/** An ack map from `[device, cursor]` pairs, every device heard at `heardAt`. */
function acksAt(heardAt: number, ...entries: [string, number][]): Map<string, Ack> {
  return new Map(entries.map(([device, cursor]) => [device, acked(cursor, heardAt)]));
}

const nobody = new Set<string>();

/** The seqs a compaction keeps, which is what nearly every assertion below is about. */
function kept(compaction: { keep: Row[] }): number[] {
  return compaction.keep.map((r) => r.seq);
}

describe("compact", () => {
  it("keeps a row two devices acked but a third did not", () => {
    const rows = [row({ seq: 1, storedAt: 0 }), row({ seq: 2, storedAt: 0 })];
    const now = 60 * DAY;
    const acks = acksAt(now, ["alpha", 2], ["beta", 2], ["gamma", 1]);

    // Older than the tail — the tail cannot be what saves row 2 here.
    expect(kept(compact(rows, acks, nobody, now))).toEqual([2]);
  });

  it("keeps a fully acked row at 29 days and drops it at 31", () => {
    const rows = [row({ seq: 1, storedAt: 0 })];
    const acks = acksAt(0, ["alpha", 1], ["beta", 1]);

    expect(kept(compact(rows, acks, nobody, 29 * DAY))).toEqual([1]);
    expect(kept(compact(rows, acks, nobody, 31 * DAY))).toEqual([]);
    // The boundary itself is inclusive: exactly thirty days old is still inside the tail.
    expect(kept(compact(rows, acks, nobody, TAIL_MS))).toEqual([1]);
  });

  it("drops nothing when the ack map is empty, however far past the tail the log is", () => {
    // The case worth asserting directly, because it is the one where being wrong loses data:
    // a group whose third device has never connected. Nobody has acked anything, so nobody
    // has consumed anything, so a log two months old is still every device's inbox.
    const rows = [
      row({ seq: 1, device: "alpha", storedAt: 0 }),
      row({ seq: 2, device: "beta", storedAt: 0 }),
    ];

    expect(kept(compact(rows, new Map(), nobody, 60 * DAY))).toEqual([1, 2]);
  });

  it("keeps the whole log for a device that has pushed but never acked", () => {
    // Same failure from the other side: gamma is on the roster because its own row is in the
    // log, so its missing ack pins the floor at zero even though alpha and beta are current.
    const rows = [
      row({ seq: 1, device: "alpha", storedAt: 0 }),
      row({ seq: 2, device: "gamma", storedAt: 0 }),
    ];
    const now = 60 * DAY;
    const acks = acksAt(now, ["alpha", 2], ["beta", 2]);

    expect(kept(compact(rows, acks, nobody, now))).toEqual([1, 2]);
  });

  it("drops an old row every device on the roster has acked", () => {
    const rows = [
      row({ seq: 1, device: "alpha", storedAt: 0 }),
      row({ seq: 2, device: "beta", storedAt: 0 }),
      row({ seq: 3, device: "alpha", storedAt: 60 * DAY }),
    ];
    const now = 90 * DAY;
    const acks = acksAt(now, ["alpha", 2], ["beta", 2]);

    expect(kept(compact(rows, acks, nobody, now))).toEqual([3]);
  });

  it("does not mutate the array it was handed", () => {
    const rows = [row({ seq: 1, storedAt: 0 })];

    compact(rows, acksAt(0, ["alpha", 1]), nobody, 90 * DAY);

    expect(rows).toHaveLength(1);
  });
});

/**
 * The two ways a device stops holding the floor, each asserted against the same log with and
 * without it — so every test shows the pin it lifts as well as the lifting, and a `compact` that
 * ignored the new argument would fail the second half rather than pass both.
 */
describe("compact — the devices that no longer hold the floor", () => {
  // Past the tail and inside the window, so the floor is the only thing deciding either row.
  const now = 200 * DAY;
  const old = now - 60 * DAY;

  it("lets go of a departed device's ack, and says to forget it", () => {
    const rows = [row({ seq: 1, storedAt: old }), row({ seq: 2, storedAt: old })];
    const acks = acksAt(now, ["alpha", 2], ["beta", 2], ["gamma", 0]);

    expect(kept(compact(rows, acks, nobody, now))).toEqual([1, 2]);

    const lifted = compact(rows, acks, new Set(["gamma"]), now);
    expect(kept(lifted)).toEqual([]);
    expect(lifted.forget).toEqual(["gamma"]);
  });

  it("lets go of a departed device's rows too, which held the floor at zero with no ack at all", () => {
    const rows = [
      row({ seq: 1, device: "gamma", storedAt: old }),
      row({ seq: 2, device: "alpha", storedAt: old }),
    ];
    const acks = acksAt(now, ["alpha", 2], ["beta", 2]);

    expect(kept(compact(rows, acks, nobody, now))).toEqual([1, 2]);

    const lifted = compact(rows, acks, new Set(["gamma"]), now);
    expect(kept(lifted)).toEqual([]);
    // Nothing to forget: gamma never acked, and its rows are compaction's to delete.
    expect(lifted.forget).toEqual([]);
  });

  it("lets go of a device unheard for longer than ACK_TTL_MS, and says to forget it", () => {
    // The reinstall: no manifest will ever name gamma's old id, so nothing departs it.
    const rows = [row({ seq: 1, storedAt: old }), row({ seq: 2, storedAt: old })];
    const acks = acksAt(now, ["alpha", 2], ["beta", 2]);
    acks.set("gamma", acked(0, now - ACK_TTL_MS - 1));

    const lifted = compact(rows, acks, nobody, now);
    expect(kept(lifted)).toEqual([]);
    expect(lifted.forget).toEqual(["gamma"]);
  });

  it("still counts a device heard exactly ACK_TTL_MS ago", () => {
    // The window is a duration, as the device roll reads its own: ninety days ago is inside it.
    const rows = [row({ seq: 1, storedAt: old }), row({ seq: 2, storedAt: old })];
    const acks = acksAt(now, ["alpha", 2], ["beta", 2]);
    acks.set("gamma", acked(0, now - ACK_TTL_MS));

    const held = compact(rows, acks, nobody, now);
    expect(kept(held)).toEqual([1, 2]);
    expect(held.forget).toEqual([]);
  });

  it("counts a device's newest row as hearing from it, however old its ack", () => {
    // Gamma last acked long ago but pushed forty days back: it is alive, and its ack holds.
    const rows = [
      row({ seq: 1, device: "alpha", storedAt: old }),
      row({ seq: 2, device: "gamma", storedAt: now - 40 * DAY }),
    ];
    const acks = acksAt(now, ["alpha", 2]);
    acks.set("gamma", acked(0, now - 2 * ACK_TTL_MS));

    const held = compact(rows, acks, nobody, now);
    expect(kept(held)).toEqual([1, 2]);
    expect(held.forget).toEqual([]);
  });

  it("keeps everything when every device it knows of has left", () => {
    // Whoever is still in the group is someone the relay has never heard from — a device paired
    // after the others left, about to replay from zero. "Nobody is behind" would compact its
    // inbox before it arrived for it.
    const rows = [
      row({ seq: 1, device: "alpha", storedAt: old }),
      row({ seq: 2, device: "beta", storedAt: old }),
    ];
    const acks = acksAt(now, ["alpha", 2], ["beta", 2]);

    const emptied = compact(rows, acks, new Set(["alpha", "beta"]), now);
    expect(kept(emptied)).toEqual([1, 2]);
    expect(emptied.forget.sort()).toEqual(["alpha", "beta"]);
  });
});

describe("departures", () => {
  it("departs every device it knows of that the roster omits, once each", () => {
    // `known` is acks UNION log senders in the object, but a caller passing duplicates must not
    // produce two marks for one device.
    expect(departures(["alpha", "beta", "alpha", "gamma"], ["alpha"])).toEqual(["beta", "gamma"]);
  });

  it("never departs a device it has not heard from, named or not", () => {
    expect(departures(["alpha"], ["zeta"])).toEqual(["alpha"]);
    expect(departures([], ["alpha"])).toEqual([]);
  });

  it("departs everyone it knows of for an empty roster — the last device leaving", () => {
    expect(departures(["alpha", "beta"], [])).toEqual(["alpha", "beta"]);
  });
});

describe("parseRoster", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `d${i}`);

  it("takes an empty roster and one as long as a manifest can be, with its epoch", () => {
    expect(parseRoster({ epoch: 0, devices: [] })).toEqual({ epoch: 0, devices: [] });
    expect(parseRoster({ epoch: 3, devices: ids(MAX_GROUP_DEVICES) })).toEqual({
      epoch: 3,
      devices: ids(MAX_GROUP_DEVICES),
    });
  });

  it("refuses a roster longer than any manifest /rotate accepts", () => {
    expect(parseRoster({ epoch: 1, devices: ids(MAX_GROUP_DEVICES + 1) })).toBeNull();
  });

  it("refuses anything that is not a list of strings under `devices`", () => {
    for (const body of [null, "alpha", [], {}, { devices: "alpha" }, { devices: [1] }]) {
      expect(parseRoster(body)).toBeNull();
    }
    expect(parseRoster({ epoch: 1, devices: ["alpha", null] })).toBeNull();
  });

  it("refuses a roster with no epoch, or one no rotation could have recorded", () => {
    // Without the epoch two crossed posts could not be ordered, so a body missing one is not a
    // roster this object can place.
    for (const epoch of [undefined, -1, 1.5, "2", Number.MAX_SAFE_INTEGER + 1]) {
      expect(parseRoster({ epoch, devices: ["alpha"] })).toBeNull();
    }
  });
});

describe("isNewerRoster", () => {
  it("applies the first roster and every strictly newer one", () => {
    expect(isNewerRoster(null, 0)).toBe(true);
    expect(isNewerRoster(3, 4)).toBe(true);
    expect(isNewerRoster(3, 5)).toBe(true);
  });

  it("ignores the same rotation's roster twice and an older one that lost the race", () => {
    // An older roster arriving second would put back a device the newer rotation removed.
    expect(isNewerRoster(4, 4)).toBe(false);
    expect(isNewerRoster(5, 3)).toBe(false);
  });
});

describe("deviceTag", () => {
  it("prefixes so a device id can never collide with a future tag namespace", () => {
    expect(deviceTag("abc123")).toBe("d:abc123");
  });
});

describe("headFrame", () => {
  it("is the three-field hint and nothing else", () => {
    expect(JSON.parse(headFrame(42, "abc123"))).toEqual({
      t: "head",
      cursor: 42,
      from: "abc123",
    });
  });
});

describe("notifyTargets", () => {
  const open = (tag: string | undefined) => ({ tag, open: true });

  it("excludes the pusher's own socket", () => {
    const targets = notifyTargets([open("d:me"), open("d:you")], "me");
    expect(targets.map((s) => s.tag)).toEqual(["d:you"]);
  });

  it("excludes a socket that is closing", () => {
    const targets = notifyTargets([{ tag: "d:you", open: false }], "me");
    expect(targets).toEqual([]);
  });

  it("notifies every other device, not just one", () => {
    const targets = notifyTargets([open("d:a"), open("d:b"), open("d:c")], "a");
    expect(targets.map((s) => s.tag)).toEqual(["d:b", "d:c"]);
  });

  it("keeps a socket with no tag rather than dropping it", () => {
    // An untagged socket cannot be proved to be the pusher's, and a missed notification is a
    // stale device. Over-notifying costs one wasted pull; under-notifying costs correctness.
    const targets = notifyTargets([open(undefined)], "me");
    expect(targets).toHaveLength(1);
  });

  it("does not mutate its input", () => {
    const sockets = [open("d:me"), open("d:you")];
    notifyTargets(sockets, "me");
    expect(sockets).toHaveLength(2);
  });
});

describe("taggedDevice", () => {
  it("reads a device back out of its tag, and nothing out of any other", () => {
    expect(taggedDevice(deviceTag("abc123"))).toBe("abc123");
    // The id may itself contain the namespace's characters: only the prefix is taken off.
    expect(taggedDevice(deviceTag("d:odd"))).toBe("d:odd");
    expect(taggedDevice(undefined)).toBeUndefined();
    expect(taggedDevice("g:group")).toBeUndefined();
    expect(taggedDevice("abc123")).toBeUndefined();
  });
});

describe("removedSockets", () => {
  const open = (tag: string | undefined) => ({ tag, open: true });

  it("closes every socket of a device the manifest does not name, and no other", () => {
    const sockets = [open("d:desk"), open("d:phone"), open("d:phone"), open("d:laptop")];
    // A device may hold two sockets for a moment — a reconnect ahead of the old one's close.
    expect(removedSockets(sockets, ["desk", "laptop"])).toEqual([open("d:phone"), open("d:phone")]);
    expect(removedSockets(sockets, ["desk", "phone", "laptop"])).toEqual([]);
  });

  it("closes everybody's for an empty roster — the last device leaving", () => {
    expect(removedSockets([open("d:desk")], [])).toEqual([open("d:desk")]);
  });

  it("names a device whole: a prefix of a kept id is another device", () => {
    expect(removedSockets([open("d:desk"), open("d:desk2")], ["desk2"])).toEqual([open("d:desk")]);
  });

  it("leaves a socket it cannot prove is a removed device's", () => {
    // Untagged, or tagged in a namespace that is not a device's: closing a member's socket costs
    // a reconnect, and leaving a stranger's open costs a frame with no data in it.
    expect(removedSockets([open(undefined), open("g:other")], [])).toEqual([]);
  });

  it("skips a socket that is already closing", () => {
    expect(removedSockets([{ tag: "d:phone", open: false }], ["desk"])).toEqual([]);
  });

  it("is the pusher's rule's other half: what it closes is never told of a push again", () => {
    const sockets = [open("d:desk"), open("d:phone")];
    const gone = new Set(removedSockets(sockets, ["desk"]));
    // Closed, the removed device's socket is not `open`, which is what `notifyTargets` reads.
    const after = sockets.map((socket) => ({ ...socket, open: !gone.has(socket) }));
    expect(notifyTargets(after, "laptop").map((s) => s.tag)).toEqual(["d:desk"]);
  });

  it("closes with a code of its own, which is not a dropped group's", () => {
    // `sync_engine::live` reads the two differently (`CLOSE_REMOVED` and `CLOSE_DROPPED` there):
    // a removal is one row and the removal's sentence; a dropped group is a lapse, and no row.
    // And every released client reads 4001 as "the group no longer exists" — which a device's
    // own Leave must never be told.
    expect(CLOSE_REMOVED).toBe(4002);
    expect(CLOSE_DROPPED).toBe(4001);
  });
});
