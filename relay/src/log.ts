import { DEVICE_TTL_MS, MAX_GROUP_DEVICES } from "./groupauth";

/**
 * The relay's whole brain, as pure functions over a row list.
 *
 * **Why this file exists at all, rather than the logic sitting in the Durable Object.**
 * `@cloudflare/vitest-pool-workers` would run the real `Group` class in workerd and let its
 * storage calls be asserted against, but it pulls wrangler and workerd into the tree and peers
 * on a vitest older than the one this suite runs. Compaction, the thirty-day tail and the
 * pull cursor are all pure functions of a row list, so they live here and are tested by the
 * vitest this repo already runs. What is left in `group.ts` is storage calls and routing —
 * the part where a bug is a 500 in a log rather than a reader's data quietly disappearing.
 *
 * The size and clock bounds a push is held to are named here too, because this is the file the
 * app's own copies are fenced against: `sync_engine::wire` and `sync_engine::hlc` each read it
 * with `include_str!` and look for the line that declares their number. **So
 * `MAX_SEALED_CHARS` and `MAX_CLOCK_AHEAD_MS` are spelled for a grep as much as for a
 * compiler** — reformat either and a Rust test goes red, which is the point. The refusals built
 * from them are `admit.ts`'s.
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
 * How long a device may go unheard before it stops holding the compaction floor: ninety days,
 * and it is `groupauth.ts`'s `DEVICE_TTL_MS` by import rather than by coincidence.
 *
 * **The same reinstall is the reason for both.** A device whose data folder is wiped mints a new
 * id, so its old id is named by no manifest and a roster post never departs it — its last ack
 * would otherwise be the slowest reader the group has for the life of the group. The device roll
 * already treats a device unseen for this long as gone and gives its slot back; a floor that
 * waited longer than the roll would be keeping an inbox for a device the relay has already
 * stopped admitting as the same one.
 *
 * **What it costs is stated rather than hidden**: a device that really was in a drawer for longer
 * than this comes back to a log compacted past its cursor, and the rows in between — older than
 * the thirty-day tail, acked by every device still heard from — are not there to pull. That is the
 * drawer the roll's comment chose ninety days against, and it is the same season here.
 */
export const ACK_TTL_MS = DEVICE_TTL_MS;

/**
 * How stale `acks.heard_at` may get before a pull refreshes it: a day.
 *
 * **A pull is hearing from a device, and an ack alone would not be enough.** The app acks only
 * when its cursor moves, and a cursor *held* — a newer sender's op this build cannot read yet, a
 * child waiting on its parent — does not move for as long as the hold lasts, which for a newer
 * hold is until the reader updates. That device is alive and pulling on every trip; judged by its
 * acks alone it would age out of the floor at ninety days, and the rows it is holding for would
 * be compacted out from under the very cursor that is waiting to apply them.
 *
 * **Throttled because a write is the scarcer meter.** Refreshing on every pull would be a row
 * written per trip per device; once a day is at most one, against a ninety-day window that a
 * day's slack cannot matter to.
 */
export const HEARD_REFRESH_MS = 24 * 60 * 60 * 1000;

/**
 * The longest `sealed` the relay will store, in characters: 1.5 million.
 *
 * **Bounded by the Durable Object's row, which caps at 2 MB**, and `sealed` is base64url — one
 * byte per character — so the number is bytes as much as characters. The half-megabyte left over
 * is for the row's other six columns and for any difference between how the platform measures a
 * row and how this counts a string; an insert past the cap is an exception inside the object, a
 * 500 that bills the request and says nothing a client can act on.
 *
 * **It refuses no batch the app builds.** `sync_engine::wire` fills a batch to half a megabyte of
 * plaintext, which seals to ~0.7 M characters, and the fattest batch ever measured — two hundred
 * fully populated `collection_entries` ops — sealed to 186 188. What reaches this is one op that
 * is alone larger than a batch, and `wire::oversized` asks this same question before sealing it.
 */
export const MAX_SEALED_CHARS = 1_500_000;

/**
 * The most a group's stored log may hold, summed over `sealed`: 128 MiB of characters.
 *
 * **A fence against a runaway rather than a budget for a reader.** Durable Object storage is
 * account-wide — 5 GB on the free plan, shared by every group this relay serves — so without a
 * per-group bound one client pushing in a loop, buggy or hostile with a valid token, could spend
 * it all. With one, spending it takes some forty groups at the cap rather than one client.
 *
 * **Sized against the biggest thing a reader honestly does.** A 50 000-row bulk import is ~250
 * batches at the measured ~90 KB average, ~22 MB — and ~46 MB at the fattest measured op. The
 * thirty-day tail keeps even a fully acked import for a month, so this holds several imports
 * inside one tail with everyday editing on top, and a reader who meets it has done something no
 * collection of cards needs.
 */
export const MAX_GROUP_LOG_CHARS = 128 * 1024 * 1024;

/**
 * How far past the relay's own clock a push's `hlcMs` may be: one day.
 *
 * **Why the relay polices a clock it cannot read the ops of.** A device whose clock runs ahead
 * stamps every edit ahead, so it wins every last-writer-wins comparison against edits that
 * really happened later — and every peer that folds one of its ops drags its own hybrid logical
 * clock forward to match, for good, because an HLC never runs backwards. One bad clock becomes
 * the whole group's. The relay's clock is the one reference every device in a group shares, so
 * this is the one place the bound can be the same for all of them.
 *
 * **A day, because honest clocks are wrong by hours.** A machine that dual-boots Windows (which
 * keeps the hardware clock in local time) and Linux (which keeps it in UTC) is off by its time
 * zone's offset — up to fourteen hours — until something corrects it, and that is the largest
 * everyday error there is. A day admits all of those and refuses a clock set to the wrong date.
 *
 * **What it costs the pusher**: its outbox was stamped by the clock that was wrong, so it waits
 * — held by the app's push loop, not dropped — until real time is within a day of its stamps.
 */
export const MAX_CLOCK_AHEAD_MS = 24 * 60 * 60 * 1000;

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
 * One device's stored ack: the cursor it has consumed to, and when the relay last heard from it
 * — set by every ack, refreshed by a pull at most once per [`HEARD_REFRESH_MS`].
 */
export interface Ack {
  cursor: number;
  heardAt: number;
}

/** What a compaction pass decides: the rows to keep, and the devices whose ack to delete. */
export interface Compaction {
  keep: Row[];
  forget: string[];
}

/**
 * What survives a compaction: everything **every** device has acked is dropped, except a
 * 30-day tail (§7.7 — "compact on ack, keep a 30-day tail"), so a device that spent a
 * fortnight in a drawer reconciles precisely instead of replaying wholesale.
 *
 * `acks` maps device id → its [`Ack`]. **A device with no ack at all holds everything**, which is
 * the correct direction to be wrong: a group whose third device has never connected keeps its log
 * rather than compacting away the state that device has not seen.
 *
 * **Which devices count as "every device" is answered from the data this function can see**,
 * and that is worth stating because it is the one place a wrong answer loses rows. The roster
 * starts as the union of the ack map's keys and the devices that appear in `rows` — every device
 * the relay has ever heard from, in either direction. A device the relay has never heard from in
 * either direction is invisible here, and that is survivable for one reason only: it has by
 * definition never pulled either, so it is a new device replaying the log from zero rather
 * than a paired device with an inbox to lose. The moment it pulls and acks it joins the roster
 * and holds the log from that point on.
 *
 * **Two kinds of device are then taken off it, and both used to hold the floor for good.** A
 * device in `departed` is one a rotation's manifest omitted — removed, or left of its own accord —
 * and it has no inbox to keep: the group key it would need to open anything new has already been
 * rotated away from it. A device not heard from for [`ACK_TTL_MS`] is the reinstall no manifest
 * will ever name, because its replacement minted a new id. "Heard" is the later of its ack's
 * `heardAt` and its newest row's `storedAt`, so a device that only pushes is as alive as one that
 * only pulls. Before this, either kind was the slowest reader the group would ever have, and
 * nothing above its last ack — or above zero, for one that never acked — was compacted again.
 * `forget` names the ones of them that still have an ack row, so the pass that stopped counting
 * them also stops storing them.
 *
 * **An emptied roster keeps everything, exactly as an empty one always did.** When every device
 * the relay knows of has left or gone quiet, the devices still in the group are ones it has never
 * heard from — a device paired after the others left, about to replay from zero — and a floor of
 * "nobody is behind" would compact their inbox before they arrived for it.
 *
 * The ack lookup defaults to `0` — "has seen nothing" — and **not** to the head. Defaulting to
 * the head is the mutation this function's test suite exists to kill: it turns a relay that
 * keeps a sleeping device's inbox into one that deletes it, and the deletion is silent on both
 * ends.
 */
export function compact(
  rows: Row[],
  acks: Map<string, Ack>,
  departed: Set<string>,
  nowMs: number,
): Compaction {
  const heard = new Map<string, number>();
  for (const [device, ack] of acks) heard.set(device, ack.heardAt);
  for (const row of rows) {
    heard.set(row.device, Math.max(heard.get(row.device) ?? row.storedAt, row.storedAt));
  }

  // `<` and not `<=`, the device roll's own reading: a device heard exactly ninety days ago is
  // still inside the window, which makes the constant a duration rather than an off-by-one.
  const cutoff = nowMs - ACK_TTL_MS;
  const gone = (device: string) => departed.has(device) || (heard.get(device) ?? 0) < cutoff;

  let floor = Number.POSITIVE_INFINITY;
  for (const device of heard.keys()) {
    if (!gone(device)) floor = Math.min(floor, acks.get(device)?.cursor ?? 0);
  }
  if (!Number.isFinite(floor)) floor = 0;

  // Kept if either half of the pair fails: still ahead of the slowest device, or still inside
  // the tail. Only a row that is both behind everyone *and* older than thirty days goes.
  return {
    keep: rows.filter((row) => row.seq > floor || nowMs - row.storedAt <= TAIL_MS),
    forget: [...acks.keys()].filter(gone),
  };
}

/**
 * The devices a roster post takes out of the group: every one the object knows of — `known`, its
 * acks and its log rows' senders — that the adopted manifest does not name.
 *
 * **Only devices it knows of, and never "everyone but these".** A departed mark is what stops a
 * device holding the floor, so marking one the object has never heard from would be marking
 * nothing — and a rule that treated every unnamed id as gone would, the day one roster post
 * failed, take a device that had just joined off the floor before it had pulled its first page.
 * Knowing only the ones it has met is the direction that fails by keeping rows.
 */
export function departures(known: Iterable<string>, named: string[]): string[] {
  const keep = new Set(named);
  return [...new Set(known)].filter((device) => !keep.has(device));
}

/**
 * A roster post's body — `{ epoch, devices: [id, …] }` — or `null` for anything else.
 *
 * **At most [`MAX_GROUP_DEVICES`] ids, because that is the most a manifest `/rotate` accepts can
 * name**; a longer roster is not one this relay could have adopted, and a 400 leaves the object as
 * it was, which is the safe direction. An empty list is allowed: it is the last device leaving.
 *
 * **The ids are required to be strings and nothing more.** The route is internal — only the
 * Worker builds it, from a manifest `/rotate` already checked id by id — and a named id is only
 * ever compared with ids the object already holds and deleted from `departed`. Nothing is stored
 * *from* one, so a malformed id can do no more than fail to match.
 *
 * **`epoch` is the rotation the roster belongs to, and it is what orders two posts that crossed.**
 * Each is sent from inside the `/rotate` request that recorded it, so two rotations accepted back
 * to back post two rosters nothing else orders: without it the older one, arriving second, would
 * put back a device the newer one removed or take off one it added. [`isNewerRoster`] is the
 * comparison; a non-negative safe integer is the only shape an epoch `/rotate` records can have.
 */
export function parseRoster(body: unknown): { epoch: number; devices: string[] } | null {
  if (typeof body !== "object" || body === null) return null;
  const { epoch, devices } = body as { epoch?: unknown; devices?: unknown };
  if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 0) return null;
  if (!Array.isArray(devices) || devices.length > MAX_GROUP_DEVICES) return null;
  if (!devices.every((device) => typeof device === "string")) return null;
  return { epoch, devices: devices as string[] };
}

/**
 * Whether a roster posted for `incoming` should be applied over the one the object last applied,
 * at `applied` (`null` for none yet). **Strictly newer only**: an equal epoch is the same
 * rotation's roster delivered twice and changes nothing, and an older one is a post that lost a
 * race to a newer rotation's and must not undo it.
 */
export function isNewerRoster(applied: number | null, incoming: number): boolean {
  return applied === null || incoming > applied;
}

/**
 * A socket, as much of one as the fan-out decision needs. `group.ts` maps a real `WebSocket`
 * into this so the decision below can be tested without workerd.
 */
export interface Notifiable {
  tag: string | undefined;
  open: boolean;
}

/**
 * The one tag a socket carries. Namespaced because `acceptWebSocket` allows ten tags and a
 * future one — a group, a protocol version — must not be mistaken for a device id.
 */
export function deviceTag(device: string): string {
  return `d:${device}`;
}

/**
 * The frame, which says only "the log moved to N".
 *
 * **It carries no envelope and never will.** Delivering over the socket would need a per-device
 * read cursor this object does not have, `since`'s `(hlcMs, hlcCtr, device)` ordering
 * reproduced in a stream, and the epoch cursor-hold that `check_keys` guarantees by running
 * first on every HTTP trip. `from` is here so a device can ignore an echo of its own write
 * without consulting its cursor.
 */
export function headFrame(cursor: number, from: string): string {
  return JSON.stringify({ t: "head", cursor, from });
}

/**
 * Who gets told about a push.
 *
 * **Everyone but the pusher, and only sockets that are actually open.** `getWebSockets` may
 * still return a socket after `close` has been called — a half-closed one sits in `CLOSING` —
 * and sending to it throws.
 *
 * **An untagged socket is notified rather than skipped.** It cannot be proved to be the
 * pusher's, and the two errors are not symmetric: over-notifying costs one wasted pull that
 * finds nothing, under-notifying leaves a device silently stale.
 */
export function notifyTargets<T extends Notifiable>(sockets: T[], pusher: string): T[] {
  const own = deviceTag(pusher);
  return sockets.filter((socket) => socket.open && socket.tag !== own);
}
