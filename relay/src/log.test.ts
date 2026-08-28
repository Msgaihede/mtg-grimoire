import { describe, expect, it } from "vitest";
import { compact, since, TAIL_MS, type Row } from "./log";

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

describe("compact", () => {
  it("keeps a row two devices acked but a third did not", () => {
    const rows = [row({ seq: 1, storedAt: 0 }), row({ seq: 2, storedAt: 0 })];
    const acks = new Map([
      ["alpha", 2],
      ["beta", 2],
      ["gamma", 1],
    ]);

    // Ancient — the tail cannot be what saves row 2 here.
    const kept = compact(rows, acks, 90 * DAY);

    expect(kept.map((r) => r.seq)).toEqual([2]);
  });

  it("keeps a fully acked row at 29 days and drops it at 31", () => {
    const rows = [row({ seq: 1, storedAt: 0 })];
    const acks = new Map([
      ["alpha", 1],
      ["beta", 1],
    ]);

    expect(compact(rows, acks, 29 * DAY).map((r) => r.seq)).toEqual([1]);
    expect(compact(rows, acks, 31 * DAY)).toEqual([]);
    // The boundary itself is inclusive: exactly thirty days old is still inside the tail.
    expect(compact(rows, acks, TAIL_MS).map((r) => r.seq)).toEqual([1]);
  });

  it("drops nothing when the ack map is empty, however old the log is", () => {
    // The case worth asserting directly, because it is the one where being wrong loses data:
    // a group whose third device has never connected. Nobody has acked anything, so nobody
    // has consumed anything, so a log four months old is still every device's inbox.
    const rows = [
      row({ seq: 1, device: "alpha", storedAt: 0 }),
      row({ seq: 2, device: "beta", storedAt: 0 }),
    ];

    expect(compact(rows, new Map(), 120 * DAY).map((r) => r.seq)).toEqual([1, 2]);
  });

  it("keeps the whole log for a device that has pushed but never acked", () => {
    // Same failure from the other side: gamma is on the roster because its own row is in the
    // log, so its missing ack pins the floor at zero even though alpha and beta are current.
    const rows = [
      row({ seq: 1, device: "alpha", storedAt: 0 }),
      row({ seq: 2, device: "gamma", storedAt: 0 }),
    ];
    const acks = new Map([
      ["alpha", 2],
      ["beta", 2],
    ]);

    expect(compact(rows, acks, 120 * DAY).map((r) => r.seq)).toEqual([1, 2]);
  });

  it("drops an old row every device on the roster has acked", () => {
    const rows = [
      row({ seq: 1, device: "alpha", storedAt: 0 }),
      row({ seq: 2, device: "beta", storedAt: 0 }),
      row({ seq: 3, device: "alpha", storedAt: 60 * DAY }),
    ];
    const acks = new Map([
      ["alpha", 2],
      ["beta", 2],
    ]);

    expect(compact(rows, acks, 90 * DAY).map((r) => r.seq)).toEqual([3]);
  });

  it("does not mutate the array it was handed", () => {
    const rows = [row({ seq: 1, storedAt: 0 })];

    compact(rows, new Map([["alpha", 1]]), 90 * DAY);

    expect(rows).toHaveLength(1);
  });
});
