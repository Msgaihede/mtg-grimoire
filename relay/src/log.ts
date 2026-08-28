/**
 * The relay's whole brain, as pure functions over a row list.
 *
 * **Why this file exists at all, rather than the logic sitting in the Durable Object.**
 * `@cloudflare/vitest-pool-workers` would run the real `Group` class in workerd and let its
 * storage calls be asserted against, but it pulls wrangler and workerd into a tree pinned to
 * vitest 4.1.10 whose support it does not advertise. Compaction, the thirty-day tail and the
 * pull cursor are all pure functions of a row list, so they live here and are tested by the
 * vitest this repo already runs. What is left in `group.ts` is storage calls and routing —
 * the part where a bug is a 500 in a log rather than a reader's data quietly disappearing.
 */

/**
 * One stored row. **`sealed` is opaque and stays opaque**: the relay orders and compacts by
 * `hlcMs`/`hlcCtr`/`device` and never looks inside. It could not if it wanted to — the group
 * key is on the paired devices and nothing here has ever seen it.
 *
 * `seq` is the relay's own arrival counter and is the only thing a client's cursor names.
 * `hlcMs`/`hlcCtr`/`device` are the sending device's hybrid logical clock, copied out of the
 * envelope so the relay can sort without decrypting anything.
 */
export interface Row {
  seq: number;
  device: string;
  epoch: number;
  hlcMs: number;
  hlcCtr: number;
  sealed: string;
  storedAt: number;
}

/** Thirty days, as milliseconds. §7.7's tail, written once. */
export const TAIL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The group's own ordering: `(hlcMs, hlcCtr, device)`, which is exactly the field order
 * `Hlc` derives `Ord` over on the Rust side. The device id is the third term and it is not
 * decoration — it is what makes the order *total*, so two devices that stamped the same
 * millisecond and the same counter still sort the same way on every device in the group.
 */
function compareHlc(a: Row, b: Row): number {
  if (a.hlcMs !== b.hlcMs) return a.hlcMs - b.hlcMs;
  if (a.hlcCtr !== b.hlcCtr) return a.hlcCtr - b.hlcCtr;
  if (a.device < b.device) return -1;
  if (a.device > b.device) return 1;
  return 0;
}

/**
 * What a pulling device gets: everything after its cursor, in the group's own order.
 *
 * **Ordered by `(hlcMs, hlcCtr, device)` and not by `seq`.** `seq` is arrival order at the
 * relay, which is a fact about the network; the hybrid logical clock is the group's ordering
 * and is the same on every device. A device that consumed in arrival order would fold the same
 * ops in a different sequence from its peers — which `merge::fold` is order-independent
 * against, but the relay's own compaction is not.
 *
 * **`exclude` is the puller's own device id, and dropping its rows is not an optimisation.**
 * A device that re-applied what it wrote would hand its own ops back to `apply` as if they had
 * come from a peer; the watermark makes that harmless and the bandwidth makes it silly, and
 * neither is a reason to send them.
 *
 * The input array is not mutated: `filter` copies before `sort` sorts.
 */
export function since(rows: Row[], cursor: number, exclude: string): Row[] {
  return rows.filter((row) => row.seq > cursor && row.device !== exclude).sort(compareHlc);
}

/**
 * What survives a compaction: everything **every** device has acked is dropped, except a
 * 30-day tail (§7.7 — "compact on ack, keep a 30-day tail"), so a device that spent a
 * fortnight in a drawer reconciles precisely instead of replaying wholesale.
 *
 * `acks` maps device id → cursor. **A device with no ack at all holds everything**, which is the
 * correct direction to be wrong: a group whose third device has never connected keeps its log
 * rather than compacting away the state that device has not seen.
 *
 * **Which devices count as "every device" is answered from the data this function can see**,
 * and that is worth stating because it is the one place a wrong answer loses rows. The roster
 * is the union of the ack map's keys and the devices that appear in `rows` — every device the
 * relay has ever heard from, in either direction. A device the relay has never heard from in
 * either direction is invisible here, and that is survivable for one reason only: it has by
 * definition never pulled either, so it is a new device replaying the log from zero rather
 * than a paired device with an inbox to lose. The moment it pulls and acks it joins the roster
 * and holds the log from that point on.
 *
 * The ack lookup defaults to `0` — "has seen nothing" — and **not** to the head. Defaulting to
 * the head is the mutation this function's test suite exists to kill: it turns a relay that
 * keeps a sleeping device's inbox into one that deletes it, and the deletion is silent on both
 * ends.
 */
export function compact(rows: Row[], acks: Map<string, number>, nowMs: number): Row[] {
  const roster = new Set<string>(acks.keys());
  for (const row of rows) roster.add(row.device);

  let floor = Number.POSITIVE_INFINITY;
  for (const device of roster) floor = Math.min(floor, acks.get(device) ?? 0);
  if (!Number.isFinite(floor)) floor = 0;

  // Kept if either half of the pair fails: still ahead of the slowest device, or still inside
  // the tail. Only a row that is both behind everyone *and* older than thirty days goes.
  return rows.filter((row) => row.seq > floor || nowMs - row.storedAt <= TAIL_MS);
}
