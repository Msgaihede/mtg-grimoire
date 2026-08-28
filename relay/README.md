# `relay/` — the sync relay

A Cloudflare Worker with **one SQLite-backed Durable Object per pairing group**. It holds a
compacted log of sealed envelopes, hands each device the ones it has not seen, and forgets the
ones every device has acked once they are older than thirty days.

**Nobody has deployed this.** No Worker exists, no Durable Object namespace exists, no account
was touched. The source is here and it type-checks; the deploy is a decision for Markus, and
the one command is `npx wrangler deploy` from this directory. The resulting URL is recorded
**nowhere in this repository** — this repo is public. It goes into the reader's own
`sync_state.relay_url`, through Settings, on each of their devices. An empty `relay_url` means
sync is off, which is the state every existing installation is in.

## What it cannot do

**It cannot read anything it stores.** The group key is minted during pairing and lives only on
the paired devices; the relay sees a `sealed` string, an epoch, a device id and a hybrid logical
clock. It orders and compacts by the clock and never looks inside. There is no authentication
on the endpoints and that is deliberate: what guards a group is that its id is a 128-bit random
uid, and what guards its contents is a key the relay has never held.

**It cannot un-tell a removed device what it already knows.** That is §7.6's problem, not this
file's.

## The endpoints

All three live on one Durable Object, addressed by `idFromName(group)`.

| Request | Body | Answer |
| --- | --- | --- |
| `POST /g/{group}/push` | one `Envelope` | `200 {"cursor": <seq>}` — the stored row's seq |
| `GET /g/{group}/pull?since={cursor}&device={id}` | — | `200 {"envelopes": [...], "cursor": <head>}` |
| `POST /g/{group}/ack` | `{"device": id, "cursor": n}` | `204` — and compaction runs |
| `GET /g/{group}/ws` | — | `501`. See "What is not built" |

`{group}` is constrained to `[A-Za-z0-9_-]{1,128}`. Without that constraint `%41` and `A` would
name two different Durable Objects that a reader would read as one group, and there is no later
point at which that becomes visible.

**A push whose envelope names a different group is refused with 409.** A Durable Object is
addressed by id, and the id is derived from the same path segment — so a body that disagrees has
reached an object that is not its own. That is either a client bug worth seeing or an attempt to
write into somebody else's log.

**The cursor a pull hands back is the head of the whole log, not of the returned slice.** The
slice has the puller's own rows filtered out of it, and a cursor taken from the slice would sit
below them, so the device would re-ask for its own rows on every pull for as long as they
survived compaction.

## Where the logic is

`src/log.ts` — `since`, `compact` and `TAIL_MS`, as pure functions over a row list, tested by
the **root** vitest (`npm run test:run -- relay/src/log.test.ts`).

`src/group.ts` — the Durable Object: two `sql.exec` tables, three handlers, and a call into
`log.ts` for every decision about which rows.

`src/index.ts` — the router.

**Why the split.** `@cloudflare/vitest-pool-workers` would run the real class in workerd, but it
pulls wrangler and workerd into a tree pinned to vitest 4.1.10 whose support it does not
advertise. Compaction, the pull window and the thirty-day tail are all pure functions of a row
list, so they are testable without any of that, and what is left in the Durable Object is SQL
and routing — where a bug is a 500 in a log rather than a reader's data quietly disappearing.

The one thing a deploy verifies that no test here can: `seq INTEGER PRIMARY KEY AUTOINCREMENT`.
`AUTOINCREMENT` is not decoration — a plain rowid is reused after a delete, so a compaction pass
that emptied the log would restart `seq` at 1 and every device holding a cursor of 5 would
silently skip the next five rows. If workerd's SQL dialect refused it, `CREATE TABLE` would fail
loudly on the first request rather than quietly.

## The free-tier arithmetic

Limits verified live 2026-08-27. Workers: **100 000 requests/day**, 10 ms CPU per invocation,
3 MB script. Durable Objects **are on the free plan, SQLite-backed only**: 100 000 req/day,
13 000 GB-s/day, **5 GB storage**, 5 M row reads/day, **100 000 rows written/day**.

Sized against the measured data — full state 381.0 KB JSON → 44.7 KB gzipped, average op
**453 bytes** on the wire — for three devices at 50 edits/day:

| | Modelled | Free limit | Use |
| --- | --- | --- | --- |
| relay requests/day | ~1 440 | 100 000 | ~1.4% |
| compacted log | ~484 KB | 5 GB | 0.01% |
| rows written/day | ~3 | 100 000 | 0.003% |

**The requests figure is the polled one.** Edit-driven traffic alone is ~100–150/day; this PR
ships HTTP pull-and-push rather than the WebSocket fan-out, and a device that polls every 60 s
spends 1 440 requests whether anything changed or not. Three devices share one group, so the
group's total is the poll rate and not three times it.

**The one case that gets near a limit is a bulk import.** 50 000 rows at one op per stored row
would spend half a day's write budget. Batching **200 ops per stored row** makes it 250 writes.
That batch size is derived from the limit, not chosen for tidiness — and 200 × 453 B = 90.6 KB
against Durable Objects' 2 MB per-row cap, so the batch is nowhere near it either.

**KV is ruled out of the hot path**: 1 000 writes/day on the free plan. **No R2.** One
SQLite-backed Durable Object per pairing group, and nothing else.

## What is not built: the WebSocket

§7.7 of the spec says the Durable Object "fans out to connected devices over hibernatable
WebSockets". This ships HTTP pull-and-push instead, and `/g/{group}/ws` is a `501` that keeps the
route in the object's shape. Three reasons:

1. **`reqwest` has no WebSocket client**, and `tokio-tungstenite` does not compile to
   `wasm32-unknown-unknown` — which would make the web target's core un-buildable.
2. **A socket from the page would need the CSP widened.** `tauri.conf.json` grants
   `connect-src 'self' ipc: http://ipc.localhost` and nothing else. Widening it is a decision to
   take once, for all three targets, in the PR where the browser's own `WebSocket` is available.
3. **Polling is comfortably inside the free tier**, as the table above shows.

What is lost is latency: a change made on a phone shows on the desktop within a minute rather
than instantly. What is kept is a core that still compiles to wasm and a CSP that still grants
nothing.
