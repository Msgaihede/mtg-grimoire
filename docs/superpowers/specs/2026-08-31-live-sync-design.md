# Live sync — the doorbell, and the scheduler that was deferred

**2026-08-31.** Sync is manual. `client::run_once` has exactly two production callers — the
**Sync now** button at `SyncPanel.tsx:483` and the revoke path at `sync_pair/pairing.rs:543` —
and there is no `setInterval`, no `refetchInterval` and no Rust timer anywhere. A change made on
the phone reaches the desktop when somebody presses a button on the Settings page.

This document takes the decision
[the hosted relay design](2026-08-29-hosted-relay-and-patreon-design.md) §8 deliberately
refused:

> *"Because sync is manual today (§3.1), the scheduler is a separate decision and this design
> does not take it. The table above is what to take it with."*

The reader asked for four things: sync without pressing anything, changes batched rather than
sent one at a time, sync at startup and shutdown and on an interval, and — the important one —
**devices that do not sync unless there is something to sync**, which needs somebody to tell them.

The last of those is the whole design. The first three are consequences.

---

## 1. What is there now

**Push is already free to gate.** `client::unpushed` (`client.rs:743`) selects
`WHERE pushed_at IS NULL`, served by the partial index `idx_sync_ops_unpushed`
(`schema.rs:3755`), and `push` short-circuits at `Ok(0)` when the result is empty
(`client.rs:834-836`). "Do I have anything to send?" is one index scan and no network. It is
already exposed as `RelayStatus.pending`.

**Pull is not, and an idle round trip is not free.** `round_trip` (`client.rs:1121`) is
`check_keys` → `push` → `pull` → `emit_baselines` → `ack`. `/keys` is D1-only and bills once;
`pull` and `ack` each reach the Durable Object and bill twice. An idle sync that finds nothing
still spends **five billed units**, and `ack` fires whether or not the cursor moved
(`client.rs:1160`).

**There is no probe.** `pull` is an unconditional `GET` with no `If-None-Match`, no `HEAD` and no
count route. On an idle group it returns `{"envelopes": [], "cursor": N}` and costs the same as
one that returns work.

**The relay reserves the shape and implements none of it.** `GET /g/{group}/ws` is in `ROUTE`
(`index.ts:74`), has `METHOD.ws = "GET"` (`:79-86`), and is **behind the bearer gate** — `rotate`
and `keys` short-circuit ahead of it at `:157-158`, `ws` does not, so it reaches
`stub.fetch(request)` at `:185` with a verified token whose `grp` claim already had to match.
The Durable Object then answers `501` (`group.ts:249-251`). Routing and auth are done. Nothing
else is: there is no `Upgrade` handling, no `WebSocketPair`, no hibernation API imported anywhere
in `relay/`, and no `wrangler.jsonc` change.

**`sync_engine` emits no Tauri events.** Zero hits for `emit`/`Emitter`/`AppHandle` across
`sync_engine/` and `sync_pair/` — neither module even holds a handle. Every `app.emit` in the
crate is elsewhere (`sync.rs:590,604,682,891`, and five more).

---

## 2. The four decisions

| Question | Answer |
| --- | --- |
| How fast must a change travel? | **Within seconds, always.** Not "when you next look". |
| When is the socket open? | **Desktop always** while the app runs, minimized included. **Android on resume, dropped on pause.** |
| A remote change arrives mid-edit? | **Always apply, always repaint.** |
| How does the reader know it works? | **A ribbon indicator**; Settings keeps the panel, the roster and `Sync now`. |

---

## 3. The transport, and why the poll is the expensive option

Cloudflare limits verified 2026-08-31. Every HTTP request to a `/g/…` route that reaches the
Durable Object bills twice — one Worker invocation, one DO request. A **hibernating** WebSocket
does not work that way:

- **The upgrade costs one Worker request and one DO request. That is the whole connection.**
- **Outgoing messages are free** — pricing footnote 2: *"There is no charge for outgoing
  WebSocket messages, nor for incoming WebSocket protocol pings."* One device pushing and the
  Durable Object fanning out to four others adds nothing to the bill.
- **An idle hibernated socket accrues no duration.** Explicitly including the window before the
  runtime hibernates it.
- Workers bill CPU, not wall clock, so the Worker half of the double-billing collapses to one
  request **per connection** rather than per message.

| Approach | DO requests/group/day | GB-s/group/day | Groups on free |
| --- | --- | --- | --- |
| **Hibernating WS + protocol pings** | ~25 | ~0.02 | **~4 000** |
| Manual — what ships today | ~70 | — | ~1 400 |
| 5-minute poll | ~1 440 | ~0.4 | ~69 |
| SSE from a Durable Object | ~10 | **3 686** | **~3** |
| HTTP long-poll, 60 s | ~2 400 | **3 686** | **~3** |

**The table models a device connected 8 h/day**, which is where its 3 686 GB-s comes from —
0.125 GB × 28 800 s. A socket held 24 h costs 10 800, which is the figure in the `accept()`
paragraph below. Duration is *"shared across all requests active on an Object at once"*, so five
devices in one group cost the same wall clock as one.

**SSE and long-polling are not close.** Workers' limits say *"Durable Objects remain active while
a request, RPC call, response stream, WebSocket, or pending I/O is in flight"* — a held-open
stream is non-hibernatable and bills wall clock at 128 MB however idle it is. Both blow the
13 000 GB-s/day free ceiling at **three or four groups**. They are not options for a relay one
person runs.

**Cloudflare Pub/Sub is retired** — the private beta ended 2025-08-20 and the docs path
redirects. Durable Object WebSockets *is* the product.

**The `accept()` trap, and it is worse than "costs more".** Pricing footnote 4: *"Calling
`accept()` on a WebSocket in an Object will incur duration charges for the entire time the
WebSocket is connected."* Footnote 5: duration bills **128 MB flat, regardless of actual usage**.
So a single idle socket left on `accept()` burns 0.125 GB × 86 400 s ≈ **10 800 GB-s per day
against a 13 000 GB-s/day allowance — 83% of the free tier, for one connection doing nothing.**

It produces no error. It is the most expensive mistake available in this feature, it is easy to
make because `accept()` is what every non-Cloudflare tutorial shows, and **mixing the two is
worse than either**: one `accept()` anywhere disables hibernation for the whole object. The
review checklist asserts it by inspection, because no unit test can reach it.

### The two blockers in the record, and why neither survives

`client.rs:3-14` and `relay/README.md:499-514` both give three reasons the socket was not built.
Two of them are about a socket opened **from the page**, and this one is not.

1. **"`tokio-tungstenite` does not build for `wasm32-unknown-unknown`."** True, and irrelevant if
   nothing on wasm names it. `Cargo.toml:135` already has
   `[target.'cfg(not(target_family = "wasm"))'.dependencies]`, with `tokio` and its `sync`/`time`
   features already inside it.
   ⚠️ **But `sync_engine` itself compiles for wasm** — `lib.rs:127` is `pub mod sync_engine;` with
   no gate, deliberately (`lib.rs:121-126`: *"Every layer of the engine compiles for wasm, and
   that is the point rather than a bonus"*). So the dependency being gated is not enough: **every
   line of code that names the crate must carry the same `cfg`**, or the wasm build fails on an
   unresolved import. And `npm run verify` **does not build wasm** — only CI's `wasm` job does,
   gated on the `changes` classifier.
2. **"The CSP would need widening."** It would not. `connect-src 'self' ipc: http://ipc.localhost`
   governs the **webview's** connections. The app already reaches
   `https://mtg-grimoire-relay.denmark-east.workers.dev` from `reqwest` in the Rust process under
   that exact CSP, and the two-device pass on 2026-08-29 worked. A `tokio-tungstenite` socket
   bypasses it the same way. `tauri.conf.json` is not edited by this design.
3. **"Nothing polls, so nothing is being spent."** Correct, and this design is the decision to
   start spending — on the cheapest curve available.

A fourth reason to keep the socket in Rust, which the record does not mention: **a browser's
`WebSocket` constructor cannot set an `Authorization` header.** Because `tokio-tungstenite`
builds an arbitrary upgrade request, the existing bearer gate at `index.ts:169-181` works
unchanged. A socket from the page would have forced the gate onto a query parameter or a
subprotocol — a relay change, and a worse one.

**Note for a future web target.** The web build has **no CSP at all** — nothing in
`vite.web.config.ts`, `src/pwa/` or `src/workers/` sets one. So *"widening the CSP is a decision
to take once for all three targets"* was never true: two of the three have nothing to widen. It
is also moot, because `web/route.rs`'s `COMMANDS` contains no `sync_*` relay command — **device
sync does not exist on the web target**, and this design does not add it.

---

## 4. The shape: a doorbell, not a delivery van

**On `push`, the Durable Object sends every other connected device a frame that says only "the
log moved to N". The device then runs the ordinary HTTP round trip.** The socket carries no card
data and no protocol.

The alternative — streaming envelopes down the socket — was considered and refused. The Durable
Object holds **no per-device read cursor**: `acks` exists solely to feed compaction
(`group.ts:229-240`) and nothing reads it to decide what a pull returns. `pull` sorts by
`(hlcMs, hlcCtr, device)` rather than by `seq` (`log.ts:66`), so a stream would have to reproduce
that ordering. And the rule that makes key rotation survivable — do not advance the cursor past
an envelope from an epoch this device cannot yet read (`client.rs:955-957`) — depends on
`check_keys` running **first** on every trip, which a socket delivery bypasses. Two transports
for one protocol means two places the conflict engine can be wrong, and only one of them has
tests.

**What this buys: if the socket fails, the app is exactly where it is today.** That property is
the reason for the choice; the request-count difference is noise.

### The frame

```json
{ "t": "head", "cursor": 1234, "from": "<device id>" }
```

`from` is the pusher, so a device can ignore an echo of its own write without consulting its
cursor. `cursor` is the same value `push` already returns to the pusher — the `seq` from
`INSERT … RETURNING seq` (`group.ts:157-166`).

**A frame is a hint, never a fact.** Two rules follow and both go in the code as comments:

- A device acts on a frame only if `cursor > PULL_CURSOR`. It never trusts the number for
  anything else.
- **A frame arriving is not the cursor advancing.** A device behind a key rotation deliberately
  does not advance (`client.rs:955-957`) and will still be behind after the trip. Nothing may
  retry purely because `cursor > PULL_CURSOR` remains true, or that device spins until
  `check_keys` hands it the new key. The retry budget is the reconnect backoff and nothing else.

---

## 5. The relay

### 5.1 `group.ts` — the upgrade

⚠️ **`Group` is `implements DurableObject`, not `extends`, and its constructor discards `state`**
— it keeps `state.storage.sql` and `state.id.name` and nothing else. So **every Cloudflare code
sample will not compile here**: they all write `this.ctx`, which exists only on the base class.
The first edit is a retained field:

```ts
private readonly state: DurableObjectState;
constructor(state: DurableObjectState) {
  this.state = state;          // new
  this.sql = state.storage.sql;
  this.ownName = state.id.name;
```

All three hibernation handlers are optional (`?`) on the ambient `DurableObject` interface, so
adding them needs no base-class change.

The `501` at `group.ts:249-251` becomes a real handshake:

- Reject a non-upgrade with **426** (`statusText: "Durable Object expected Upgrade: websocket"`) —
  Cloudflare's own sample. **Lower-case the header before comparing**: RFC 6455 makes the token
  case-insensitive, every doc sample compares case-sensitively, and whether the runtime
  normalises first is undocumented.
- `Object.values(new WebSocketPair())` — the pair has **numeric keys `0` and `1`**, not
  `client`/`server`; `0` is the client end returned to the caller, `1` is the one you accept.
- **`this.state.acceptWebSocket(server, tags)`**, with the device id as the one tag — never
  `accept()`, for the reason in §3. Tags are capped at **10 per socket, 256 characters each**,
  can only be set at accept time, and `getTags` throws on a socket that was never accepted this
  way.
- `Response(null, { status: 101, webSocket: client })`.
- `deviceId` comes from `?device=` on the URL, exactly as `pull` reads it (`group.ts:174`). The
  bearer gate has already proved group membership; the parameter only says which member.

**No session map, and no constructor rehydration.** Every Cloudflare sample builds a
`Map<WebSocket, …>` in `fetch()` and rebuilds it from `getWebSockets()` in the constructor,
because in-memory state is discarded at hibernation. **We need neither**: `getWebSockets()`
already returns hibernated sockets — that is what makes the samples' rehydration work at all —
so calling it at fan-out time is the whole mechanism. `serializeAttachment` stays unused too. This
matters beyond tidiness: constructor rehydration is the one path `@cloudflare/vitest-pool-workers`
`evictDurableObject` exists to test, and this repo cannot run it (§12). Not having the path is
better than having an untestable one.

Handlers: `webSocketMessage` exists and stays trivial — we expect no application messages at all.
⚠️ **A missing or misspelled handler is a silent no-op**: read out of `workerd`'s
`sendHibernatableWebSocketMessage`, an unhandled message is dropped with no error and no log,
**while the object still wakes and still bills the request**. A typo reads exactly like "the
client isn't sending anything". `webSocketClose`/`webSocketError` need no bookkeeping, and
because `compatibility_date` is `2026-08-27` — past `2026-04-07` — the
`web_socket_auto_reply_to_close` flag is on by default and the runtime completes the close
handshake itself. **`ws.close()` inside `webSocketClose` is redundant here**, and the `1006`
trap that bites older compatibility dates is closed.

**Hibernation hygiene is a hard constraint.** The lifecycle page states its condition list as
exhaustive: no pending `setTimeout`/`setInterval`, no in-flight awaited `fetch()`, **no use of
the standard WebSocket API**, no request still being processed, no active outbound connection.
Breaking any one silently converts every idle socket into a billed one, with no error and no test
that can see it. Two clarifications worth writing down because both are easy to get wrong:

- **A SQL cursor does not block hibernation.** `sql.exec()` is synchronous and returns a cursor
  immediately, so there is no such thing as one "in flight". What it does risk is reading across
  an `await` and observing rows from a transaction that later rolls back — so drain every cursor
  with `.toArray()` before any `await`. `rows()` and `compactNow()` already do.
- **We use no alarms.** Whether a *scheduled* alarm blocks hibernation is not documented either
  way; the design sidesteps the question rather than betting on an inference.

**Keepalive is the client's job and costs nothing — and there is no alternative.** The Durable
Object **cannot initiate a protocol ping**: `ping` appears in neither `workerd`'s JSG method
table for `WebSocket` nor `@cloudflare/workers-types`, and a server-side heartbeat would need a
timer, which blocks hibernation outright. **Server-initiated keepalive and hibernation are
mutually exclusive.** Client protocol pings are the only shape that keeps both: Cloudflare
auto-responds, does not call `webSocketMessage` for control frames, *"does not interrupt
hibernation"*, and does not bill them. `tokio-tungstenite` sends `Message::Ping`; a browser
cannot, which is a fifth reason the socket lives in Rust. `setWebSocketAutoResponse` stays
unused — it is free of *duration* but its replies are still incoming *messages* against the
request meter, and `workerd` issue #1009 says it does not work under `wrangler dev` anyway.

### 5.2 `group.ts` — the fan-out

Inside the existing `push` handler (`group.ts:133-170`), after the `INSERT … RETURNING seq`:

```ts
for (const peer of this.state.getWebSockets()) {
  if (this.state.getTags(peer)[0] === `d:${pusher}`) continue;
  if (peer.readyState !== WebSocket.OPEN) continue;   // skips CLOSING leftovers
  peer.send(frame);
}
```

The `readyState` guard is Cloudflare's own rule: *"`getWebSockets` may still return WebSockets
even after `ws.close` has been called"*, because a half-closed socket sits in `CLOSING`.

**No sender-side coalescing.** A 50 000-row import is 250 sequential POSTs (§7), so a burst emits
250 frames per peer. Outgoing messages are free and the object is already awake handling the push,
so the frames cost nothing; what would cost is peers *reacting* 250 times, and §6.2's receiver
debounce solves that. Keeping it here means no timer and no `alarm()`, so nothing obstructs
hibernation.

⚠️ Cloudflare does caution that *"sending many small messages can overwhelm a single Durable
Object … even if the total data volume is small"*. If a live pass shows it, the escape hatch is a
`?notify=1` flag the client sets on the **final** chunk of a push run — zero extra requests, zero
timers, 250 frames collapsing to one. It is named here so it is not re-derived, and deliberately
not built.

### 5.3 `/drop` must close the sockets

`claim.ts`'s `releaseGroup`/`revoke` already reach the Durable Object through the internal
`POST /g/{g}/drop` (`group.ts:261`, built by the Worker at `claim.ts:449`). **A dropped group
whose devices still hold open sockets would keep receiving frames**, and a 24-hour bearer token
stays valid past the drop. So `drop` loops `getWebSockets()` and closes each with **`4001`** —
the private range, chosen so the Rust client can distinguish "you were removed" from any
transport-level close.

Close-code rules, from `workerd`'s validation: **1000–4999 excluding 1004/1005/1006/1015**, a
reason of at most **123 bytes UTF-8**, and a reason without a code throws. There is no "close
all" API; the loop is it. `state.abort()` exists and is the wrong tool — it logs an uncatchable
error and kills every socket in the group.

### 5.4 Two fixes that become load-bearing

**`pull` reads the whole log on every call.** `rows()` (`group.ts:267-280`) is
`SELECT seq, device, epoch, hlc_ms, hlc_ctr, sealed, stored_at FROM log` with **no `WHERE`**,
`.toArray()`'d, then filtered in JavaScript. A group carrying a 30-day tail re-reads all of it —
every `sealed` blob — on every pull that finds nothing. It gets `WHERE seq > ?`.

**Every ack triggers a second full scan.** `compactNow()` (`group.ts:229-239`) is called from
exactly one place, `ack()` at `:219`, and re-reads the same table. It runs only when the ack
actually advanced that device's stored cursor.

### 5.5 Token expiry

`TOKEN_TTL_MS` is 24 h (`token.ts:41`). The token is checked once, in `fetch()`, at upgrade time,
and **a hibernated socket is never re-authorised**. There is no per-message gate available
either, because no application messages arrive — protocol pings never reach `webSocketMessage`.

So the mechanism is entirely client-side: **the client closes and reconnects when it refreshes
its token**, and a socket never outlives its ticket. One extra connection per device per day,
inside the ~25/day figure in §3. The relay-side backstop for the case that matters — a device
that was *removed* rather than merely expired — is §5.3's `drop`.

---

## 6. The Rust side

A new module `sync_engine/live.rs`, entirely `#[cfg(not(target_family = "wasm"))]` for the reason
in §3. `tokio-tungstenite` goes in the `cfg(not(wasm))` dependency block at `Cargo.toml:135`, and
**must take a `rustls` feature, not its `native-tls` default** — `reqwest` is `rustls-tls`
(`Cargo.toml:62`) and a second TLS stack in a portable exe buys nothing.

### 6.1 The connection manager

One long-lived task, spawned from `desktop.rs` `setup()` beside the six already there.

- **Connects when** entitled-or-paired **and** in a group — the same conditions under which
  `run_once` currently returns `Ok(None)` with no traffic (`client.rs:1140-1145`). An
  installation that has connected nothing opens no socket, which is every installation today.
- `Authorization: Bearer <token>` on the upgrade.
- **Jittered** exponential backoff. Cloudflare restarts servers as it deploys, so every group's
  sockets drop in the same instant; without jitter every device on the relay reconnects
  simultaneously.
- Protocol ping every ~45 s. The edge closes idle sockets after an interval Cloudflare does not
  document — "a period of time" — so this is a guess to be measured live, not a derived number.
- **Android**: connect on resume, drop on pause. Doze will sever a background socket anyway, and
  a phone that looks connected while being hours stale is worse than one that knows it is
  offline.

### 6.2 Seven wakes, one single-flight trip

All wakes feed one queue. One round trip runs at a time and pending requests coalesce rather than
queue.

| Wake | Timing |
| --- | --- |
| A `head` frame ahead of `PULL_CURSOR` | **~1 s debounce** — a bulk import is 250 pushes and the peer must react once |
| A local write | **~3 s of quiet** — see §6.3 |
| Launch | immediate |
| Reconnect | immediate — catches up whatever was missed while offline |
| Android resume | immediate |
| Exit | bounded, see §6.4 |
| The **Sync now** button | unchanged |

### 6.3 Where the local-write debounce is armed — and where it must not be

**Not `sync::with_write`.** The obvious choke point is wrong three times over:

- **`sync_now` runs the whole round trip inside it** — `commands.rs:407` is
  `sync::with_write(&state, |conn| runtime.block_on(client::run_once(conn)))`. A debounce armed
  there re-arms on every sync, including the automatic ones. The timer never settles.
- **It is not write-only.** `SyncPanel.tsx:1128` polls `sync_relay_status` at
  `refetchInterval: 1500`, and that command reads through `with_write` (`commands.rs:322`). A
  debounce armed there fires 40×/minute with the panel merely open.
- **Three paths write synced tables outside it**, all deliberate: `reconcile::apply`
  (`sync.rs:875`), `reconcile::sweep_orphans` (`sync.rs:1210`) — both behind
  `capture::Suppressed` — and the schema ladder, which runs on the raw connection from
  `desktop.rs:816` before `capture::install`.

**Not `update_hook` either, and this one is a silent data loss.** `db.rs:214-221` records it,
measured: **the update hook does not fire for `WITHOUT ROWID` tables.** Two of the twelve synced
tables are exactly that — `muted_tags` and, since user schema v31, `device_names`
(`schema.rs:448-464` for the list; both are `WITHOUT ROWID`). An update-hook debounce would never
sync a muted tag or a device rename, with nothing red anywhere.

⚠️ `db.rs:220` still says *"`muted_tags` is the one on the user side"*. That has been wrong since
v31 and is corrected as part of this work.

**The rule: `commit_hook` wakes, the outbox decides.**

- `commit_hook` fires **once per transaction**, is indifferent to `WITHOUT ROWID`, and does not
  fire for a read-only transaction.
- The debounced task then asks the free, indexed question:
  `SELECT count(*) FROM sync_ops WHERE pushed_at IS NULL`.

⚠️ **The notify must ride inside the existing hook, not install a second one.** SQLite allows
exactly **one commit hook per connection** — the same rule `watch.rs` states for the update hook
and the reason `CrossFileFence` rides inside the mirror's closure rather than registering its
own. `mirror/watch.rs:236` already calls `conn.commit_hook(...)` for the fence. A second
`commit_hook` would **replace** it, silently disabling the "a transaction wrote to both the user
database and the card database" diagnostic with nothing red anywhere. `install_hook` grows a
third parameter and one more line inside the closure it already owns.

**The closure must stay non-blocking and must never answer `true`** — the existing comment says
why: a commit hook that returns `true` aborts the commit, turning a diagnostic into data loss. The
notify is one `Notify::notify_one()`, which does not block and cannot fail.

This is correct by construction rather than by coincidence. A 50 000-row import is **one**
transaction holding the write lock ~1.4 s (`collection.rs:708-754`; measured in
[sync.md](../../reference/sync.md) §"Capture over a bulk import"), so it raises one event, and
nothing depends on "1.4 s happens to be under 3 s". A round trip's own commits raise events too,
but by then the outbox is empty — `push` stamps `pushed_at` per chunk and `apply` runs under
`capture::Suppressed` — so nothing schedules. The `sync_now` re-arm problem does not need an
exemption; it does not exist.

**One rule the schema ladder owes.** The capture triggers are persistent schema objects, so on
every launch after the first, `migrate_user` runs against a database that already carries them. A
future rung that writes a synced row would emit ops at startup, before any debounce is armed.
Rungs 29–31 do not (v29's `sync_uid` mint names no captured column). **A rung that touches a
synced table must state what it expects to happen to the ops it produces.**

### 6.4 Startup and shutdown

**Startup**: the connection manager's first act is a full round trip, then the socket.

**Shutdown** needs a handler that does not exist. `desktop.rs:721-725` handles only
`RunEvent::Exit`, which fires after the last window is gone, and does a WAL checkpoint. A push
needs the network *and* the write connection, so it goes in a new `RunEvent::ExitRequested` arm
with a hard budget — the same discipline `EXIT_CHECKPOINT_WAIT` already applies, and for the
reason its doc gives: *"A window-less process still sitting on a lock is a process the user
believes has quit."*

**The budget can be brutal because nothing is ever lost.** `sync_ops` is durable and
`pushed_at IS NULL` survives the process; a missed shutdown push is a delay until the next
launch, not a loss. Two seconds, then exit regardless.

---

## 7. The bulk-import burst, settled

`push` sends one envelope per POST and loops the batches itself (`client.rs:829-858`), so a
50 000-row import is **250 sequential POSTs inside one round trip**. `wire::BATCH = 200`.

**Decision: leave `BATCH` alone.** The burst is 250 Worker + 250 DO requests + ~250–500 DO rows
written — **0.25% of a daily budget**, once, on the rarest operation the app has. Raising `BATCH`
to 1 000 would save 0.2% of one day while taking the 2 MB row-cap headroom from 11× down to 2×,
and it would churn a constant that `wire.rs`'s derivation, a spec section and the test
`fifty_thousand_ops_are_two_hundred_and_fifty_stored_rows` all reason from. For scale: a
60-second poll would spend that same 250 requests every **two hours**.

**And `emit_baselines` already has the identical shape** (`client.rs:1047-1050`) — a first
pairing against a 50 000-row collection is already 250 POSTs, and `peers_needing` re-offers every
30 days. Any argument that 250 POSTs is unacceptable condemns pairing, not importing.

**A special case for imports is unnecessary**, because §6.3's debounce fires exactly once after
the transaction commits and `push` already sends everything pending in one run. "Push once at the
end" is the behaviour it already has.

---

## 8. What this design found and does not fix

**`pull` has no page size, and a notify frame is what will reach it.** `group.ts:172-197` returns
every envelope past the cursor in one response, and the client's `response.text()`
(`client.rs:917`) has no cap. A peer that was offline through a 50 000-row import pulls **250
envelopes in one body — 46.6 MB**, held as row strings plus the `JSON.stringify` copy at
**~95 MB inside a 128 MB isolate shared with every other group's Durable Object**, and over
150 MB peak on the phone.

This is reachable today at `BATCH = 200` and has nothing to do with automatic sync. What
automatic sync changes is how often the path is taken: **a doorbell that wakes a peer holding a
250-row backlog is exactly this path**, so a latent hazard becomes a routine one.

**It is named here and not fixed here.** The fix is a `LIMIT` on `pull` plus a cursor-carrying
loop on the client — a change to the pull contract on both sides, with its own tests, and folding
it into this PR would make one change that cannot be reviewed as one thing. It is the next PR
after this one, and this design's live pass must not include a 50 000-row import against an
offline peer until it lands.

---

## 9. The frontend

### 9.1 Two events

`sync:applied` carrying a `RelayOutcome`, and `sync:live` carrying a connection state. Both names
are greenfield — neither string appears anywhere in the repo.

- **No capability is needed.** `core:event`'s `global_scope_schema` is `null`; the permission is
  the four verbs and is not scoped by event name. `core:default` in `desktop.json` and
  `mobile.json` already grants it, and that is the same line that permits `sync:progress`.
- **`RelayOutcome` already exists** in the TS mirror at `ipc.ts:4162-4186`. `sync:applied` needs a
  subscriber, not a type. `sync:live`'s union is new and gets pinned by a test the moment it
  exists — `ipc.test.ts:1414-1423` argues that the event-name string is the entire contract and
  nothing in the type system holds it.
- ⚠️ **`sync_now` has no `AppHandle`** (`commands.rs:396-411` takes only `tauri::State`), and its
  body runs inside `spawn_blocking` with a nested `block_on`. The handle must be cloned in before
  that closure.
- Subscription goes through `core.listen` (`core/types.ts:9-27`), copying `onSyncProgress`
  (`ipc.ts:5193-5194`), registered **once** by `AppShell` and fanned out as props — the rule at
  `AppShell.tsx:176-178`.

### 9.2 The invalidation, which is a bug fix and not a feature

`sync_now`'s mutation invalidates only `SYNC_KEY` (`SyncPanel.tsx:761-769`). Applying pulled ops
rewrites `collection_entries`, `deck_cards`, `wishlist_entries` and the rest, and **nothing
refreshes them** — not on an automatic sync and **not on the manual button either**. It is
invisible today only because the button lives on the Settings page.

A new hook beside `useSyncInvalidation` — **not an extension of it**. That file is a phase state
machine over a prop with a `useRef` latch, and `SYNC_INVALIDATED` is the *corpus* root set: it
includes `["sets"]`, whose `staleTime` is `Infinity`, and `["card"]`, neither of which any relay
op can touch. Invalidating them on every round trip would refetch the set picker forever.

The right set is the constant that already exists for this: **`OWNED_WRITE_KEYS`**
(`query.ts:30-35` — `[["collection"], ["wishlist"], ["cards","search"], ["decks"]]`) plus
`SYNC_KEY`, because `RelayStatus.pending`, `lastSyncAt` and `reviewCount` all move too.

The listener **supplements** rather than replaces `SyncPanel`'s `onSettled`, because it must also
fire for trips this window did not start.

### 9.3 The ribbon

The indicator sits in the `ml-auto` group at `Ribbon.tsx:230`, between the update button
(`:237-259`) and the "Already up to date" line, taking `deviceSync?: DeviceSyncState | null` and
`onOpenSync?: () => void` with `null`/undefined defaults — `updateVersion`'s exact pattern
(`:60,:163`), so a target that passes nothing draws nothing. `onOpenSync` copies
`onOpenUpdate`'s `() => setActiveView("settings")` (`AppShell.tsx:462`).

⚠️ **`Ribbon.test.tsx` calls the singular `getByRole("status")` in six places** (`:53,:154,:159,
:184,:279,:293`), which throws on multiple matches. The existing second live region survives only
because it is conditional on `upToDate && !busy && !hasError`. **The indicator must not add an
unconditional third `role="status"`** — it carries a tooltip and no live-region role.

Three states, because they fail differently: **connected** (silent, or the pending count during a
push), **offline** (the state automatic sync introduces, and the only one that must be visible),
and **absent** (no group — draw nothing, which is every installation today).

**The gate is `isWebTarget()`, not `isAndroid()`.** The parity matrix
([cross-platform-parity-matrix.md](2026-08-27-cross-platform-parity-matrix.md) §5) has Android on
Tauri events exactly like desktop; it is the web target that has no relay commands at all.
`AppShell.tsx:295-307` already carries this distinction as a comment, having been got wrong once.

### 9.4 Settings

A **separate sentence**, not an eighth `RelayState` arm. `relayState`'s seven rungs are a
priority ladder (`SyncPanel.tsx:340-366`, with the ordering argued at `:314-338`), and a
connection state is not mutually exclusive with them — "the socket is live" and "last synced
three minutes ago" are both true at once. `supporterNote` (`:571-589`) is the precedent: a second
per-state sentence function beside `relayNote`, over its own union. A third, `liveNote`, is the
shape this file already teaches. It renders as a new paragraph above the flex row at `:909`.

`PAIRING_KEY` moves from `SyncPanel.tsx` into `@/lib/query` — the file pre-commits to exactly
this at `:31-34`, naming *"PR 7's sync indicator"* as the second surface that would trigger it.

---

## 10. Two rules that are each one word from a bug

### 10.1 The ack skip must compare a watermark, not an emptiness

`pull` returns `cursor` = the head of the **whole** log, including rows the puller itself wrote —
`since()` filters the puller's own rows out of `envelopes` (`log.ts:65-67`) but `head` is
computed over everything (`group.ts:180-184`), and `group.ts:180-183` says why.

**So a device that pushes and then pulls receives zero envelopes and a strictly higher cursor.**
That is the normal case for whichever device is doing the writing.

Implement "skip the ack when the cursor did not move" as `if envelopes.is_empty()` and that
device **never acks**. Its stored ack stays at its founding value, `compact`'s floor
(`log.ts:92-99`) pins there, `row.seq > floor` keeps every row for the life of the group, and
**nothing is ever compacted** — silently, with no second trigger, because `compactNow()` has
exactly one caller.

**The skip compares `page.cursor` against a locally persisted last-acked value.** Not against
`PULL_CURSOR`, which the failing pull path also moves; not against emptiness. A new
`sync_state` key.

Two consequences even of the correct version, accepted rather than fixed:

- The ack is a separate request and can fail after the pull succeeded (`client.rs:1160` uses `?`
  and `LAST_SYNC_AT` is stamped after it at `:1161-1170`). The relay then over-retains. It
  self-heals at the next write.
- A caught-up, quiet group stops acking, so the `TAIL_MS` sweep pauses until somebody writes.
  Rows are retained, never lost.

### 10.2 A frame is a hint

Restating §4 because it is the other one-word bug: **a frame arriving is not the cursor
advancing.** A device behind a key rotation deliberately holds its cursor (`client.rs:955-957`)
and is still behind after the trip. Retrying because `cursor > PULL_CURSOR` is still true makes
that device spin until `check_keys` hands it the new key.

---

## 11. Cost, re-derived

| | DO requests/group/day | Groups on free |
| --- | --- | --- |
| Idle group — connected, nobody editing | ~25 | ~4 000 |
| Busy group — 50 edits → ~20 debounced bursts, 3 devices | ~225 | ~440 |
| Manual — what ships today | ~70 | ~1 400 |

A busy group costs ~3× manual, but **on a different curve**. A poll is paid whether or not
anybody is using the app; this is paid only when somebody edits, so it cannot run away on its
own — which is what the 2026-08-29 *"cliff, not a slope"* decision was actually worried about.
**The free plan and the ~70% notification stand**, and the notification matters more now that the
number is reader-driven.

Storage and duration never bind: 484 KB/group against 5 GB, and ~0.02 GB-s/group/day against
13 000.

⚠️ **One figure is unverified.** Cloudflare's 20:1 ratio for incoming WebSocket messages is
documented as *"for compute requests billing-only"*, and whether it applies to the free plan's
100 000/day counter is genuinely ambiguous. Every figure above assumes the pessimistic 1:1. It
barely bites: protocol pings are free and the client sends almost nothing else inbound.

---

## 12. Testing

**`group.ts` has no test file and will not get one.** `@cloudflare/vitest-pool-workers` is ruled
out — it drags wrangler and workerd into a tree pinned to vitest 4.1.10 (`log.ts:4-11`,
`fakeD1.ts:29-33`). The standing strategy is that all *decisions* live in `log.ts` as pure
functions and `group.ts` is SQL and routing. Follow it:

- **Relay** — "given a push by device D and the current socket tags, who gets a frame and what is
  in it" is a pure function in `log.ts` beside `since` and `compact`, tested in `log.test.ts`.
  The `since`-with-`WHERE` change and the compaction guard get cases there too.
- **Rust** — the same split, and it matters more. The connection manager's **policy** — when to
  connect, jittered backoff, both debounce windows, single-flight coalescing, the two hint rules
  in §10 — is a state machine with no I/O, tested against a fake clock. That is where the bugs
  will be. The socket I/O is the thin part.
- **The ack watermark (§10.1) gets a test that fails against the emptiness implementation.** It
  is the defect most likely to be written, and it is invisible to every other test.

**What no unit test can reach**, and what the live pass is therefore for:

- **That hibernation is actually happening — and `wrangler dev` cannot tell you.** Cloudflare
  states it plainly: locally *"the Durable Object is never evicted from memory"* while
  hibernatable events are still delivered, so the local server shows a passing impression of a
  design that would bill 83% of the free tier per socket. This is the repo's *"ask the host,
  never a document"* rule with a price tag on it: read it off the deployed Worker's metrics after
  an idle hour, and assert `acceptWebSocket` by inspection in review.
- The edge idle timeout, and whether ~45 s pings are enough. Cloudflare documents only *"a period
  of time"*.
- Reconnect after a Cloudflare deploy. *"Code updates disconnect all WebSockets"* — this is
  normal operation, not an error, and it happens on every relay deploy.

⚠️ **A live-pass trap.** `query.ts:1-4` sets `staleTime: 30_000` and does not touch
`refetchOnWindowFocus`, whose default is `true`. A two-device CDP pass will show rows appearing
"on their own" — **that is the focus refetch, not the invalidation**. Verify with the window kept
focused, or raise `staleTime` for the pass.

⚠️ **`npm run verify` does not build wasm.** The `cfg` discipline in §3 is proved only by CI's
`wasm` job, which is gated on the `changes` classifier.

---

## 13. Out of scope, named so it is not assumed

- **Paging `pull`** — §8. The next PR, and the reason the live pass must not import 50 000 rows
  against an offline peer until it lands.
- **Device sync on the web target.** `web/route.rs`'s `COMMANDS` has no relay command; nothing
  here adds one.
- **An off switch for automatic sync.** Not asked for; `Sync now` remains as a manual override
  and pairing nothing remains the way to sync nothing.
- **Raising `wire::BATCH`** — §7.
- **`sync_ops` retention.** Still unbounded, still owed, unchanged by this.
- **The third-device tombstone gap.** Add-wins reconciles two *other* devices' ops only if they
  arrive together. Syncing more often means smaller, more separate batches, so they arrive
  together **less** often. This design does not cause that bug but plausibly makes it more
  reachable, and it stays owed.

---

## 14. Documents this changes

- [sync.md](../../reference/sync.md) — "What is not built: the WebSocket" stops being true, and
  its corrected cost table is superseded by §11.
- [the hosted relay design](2026-08-29-hosted-relay-and-patreon-design.md) §8 — its deferral is
  discharged here.
- `client.rs:3-14` and `relay/README.md:499-514` — both describe a 60-second poll as the design.
  Neither the poll nor its reasoning survives; §3 replaces them.
- `.storybook/fake/event.ts:4-10` — the *"Five events reach the frontend"* census becomes seven.
- [cross-platform-parity-matrix.md](2026-08-27-cross-platform-parity-matrix.md):167 — the
  `api/event` row's *"(sync/tag/combo progress)"* enumeration is stale by two.
- `db.rs:220` — *"`muted_tags` is the one on the user side"*, wrong since v31 added
  `device_names`.
- `src-tauri/Cargo.toml:150,174,189` — all three name `capabilities/default.json`, which has not
  existed since the file was split into `desktop.json` and `mobile.json` for Android.

The last three are prose-only and route to neither CI job, which is why they rotted.
