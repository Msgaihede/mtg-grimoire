# Deploying the hosted relay — the runbook, and what only a deploy can settle

⚠️ **This file opened with "nothing here has been run" until 2026-08-30, and by the end of that
day two of its three halves had been.** What follows is the record of which, because the whole
value of this page is that it distinguishes them.

**The first half landed on 2026-08-29** in `e5ff435`, `86a9b8e` and `612a01e`, with
`npm run verify` green (249 test files, 5 932 frontend tests, 1 786 Rust), `cargo fmt --check`
clean, and clippy `--all-targets` clean. **Those three figures are that day's tree and have not been
re-derived**; the counts move with every branch, so take them as the record of one green run
rather than as today's number. **It is deployed**: step 1 is done, step 6 has run, and step 3 is
done — both `vars` are committed in `wrangler.jsonc`. **Two of step 4's three secrets are
provably set**, probed 2026-08-30 — `/g/{group}/pull` with a *malformed* bearer answers **401**
and not 500, and `required(env.RELAY_HMAC_KEY, …)` is called before `verify` can refuse it; the
same shape holds for `POST /webhook/patreon` with no signature, where `required(env.
PATREON_WEBHOOK_SECRET, …)` runs unconditionally ahead of `verifyWebhook`. `PATREON_CLIENT_SECRET`
is only reachable through a real code exchange, so it cannot be probed. **Step 7 is open; step 8
was built and deployed on 2026-10-01** — that step says what it is, what it is not, and how
loosely it counts.

**A second half landed on 2026-08-30** — `/token`'s group door, `POST /g/{group}/rotate`,
`GET /g/{group}/keys`, the `group_keys` table and two columns on `entitlements`. **It is deployed
too**, and its deploy is where step 2's atomicity trap was measured rather than reasoned.

**A third half is deployed**: `group_devices`, `MAX_GROUP_DEVICES`, a required `device` field on
both `/token` doors and on `/claim`, `/claim` moving a binding instead of refusing it, and
`/rotate` capping its manifest and freeing slots through `keepOnly`. It added **one migration
file** to step 2 and changed no route path.

**A fourth half is deployed too**: the pairing rendezvous — `POST`/`GET {relay}/p/{rv}/{slot}`,
the `pairing_rendezvous` table, and `/pair`'s landing page. It added a **second** migration file
to step 2 (run as its own `--command`, never a `--file` — that step says why) and two new routes.

⚠️ **Both of those halves said "not deployed" here until 2026-09-28, and both were live.** Nobody
wrote down the deploy that shipped them: `wrangler deployments list` shows three between
2026-08-30 08:50 and 2026-08-31 05:37 UTC and none after, and step 0 found both answering on
2026-09-28, before that day's deploy. The device roll's own recorded tell could never have caught
it — step 0 says why.

**A fifth half — the refresh-secret change (#541, `57a65ec`) — was deployed 2026-09-28**, from
`main` at `1512ea68`, in the order the next section gives: v0.31.0 (2026-09-27) is the first
release carrying `entitlement::refused_secret`, then the `refresh_device` column, then
`wrangler deploy`. **It has no credential-free tell** — every check it changed runs behind an auth
check or a live claim code — so it is known to be live from the tree that was deployed, not from a
probe. Step 6 has the one read that can prove it from outside.

⚠️ **A sixth half, issue #546's, is deployed — and this page said "written and not deployed" until
2026-10-01, the third time it has been behind the host.** `deployments` on the script lists two
deploys on 2026-09-28: 17:58 UTC, the refresh-secret one above, and **19:57 UTC**, nine minutes
after PR #660 merged this half into `main`. Nobody wrote the second one down. Step 0's sixth probe
— added that day and never run — answered `400 that is not an epoch` on 2026-10-01, the cron
registered on the script is `0 * * * *` (created 19:57:54 UTC), and `sqlite_master` lists
`reconciled_at` and `entitlements_reconcile`. **Which tree the 19:57 deploy was cut from is
inferred from the clock, not recorded.** The Worker admits a push
before the Durable Object hop — `413 too_large`, `409 stale_epoch`, `422 epoch_ahead`,
`422 clock_ahead`, and the object's own `507 quota` — `/keys` answers `?epoch=` and advertises
`removalStep: 2`, `/rotate` accepts a removal's two-epoch step, an accepted rotation posts its
roster to the object's internal `/roster` so a departed device's ack stops pinning compaction, the
Patreon reconciliation runs **hourly** on a budget of twenty subjects queued by a new
`entitlements.reconciled_at`, and the group door's lapse 401 carries `code: "membership_ended"`.
It adds **one migration file** to step 2, run as two `--command`s, and no public route path —
`/roster` is internal. The cron's move from `0 3 * * *` to `0 * * * *` is in `wrangler.jsonc`, so
step 6 carries it with nothing else to do. **Its app and its relay ship in either order**; "The
order" says why, and [relay/README.md](../../relay/README.md) holds the whole of what it changes.

**A seventh half — issue #548's `dev` claim (`f5223fdf`) — was deployed 2026-10-01 at 19:17 UTC**,
from `main` at `2b845048`, version `ca3dfd11`. `token.ts` stamps the presenting device into every
token and `verify` carries it through; nothing in the relay reads it, and it exists for the share
Worker's gate. **No migration, no route, and no credential-free tell** — like the refresh-secret
change it is known to be live from the tree that was deployed. Step 0's six probes and the two
secret probes of item 8 were re-run straight after and answered as before. It was the first deploy
an agent ran, at Markus's instruction that day; the rule below is otherwise unchanged.

**An eighth half — the browser's, light app phase 6 (issue #761) — is written and NOT deployed.**
Written 2026-10-04, after step 8's rate limits, which this page never numbered as a half. What the
next deploy carries:

- **`APP_ORIGINS`**, a new entry in `wrangler.jsonc`'s `vars`, shipped as exactly
  `https://mtg-grimoire.app`. It is a var and not a secret, so `wrangler deploy` carries it and no
  other command sets it.
- **CORS** on the routes a device calls with `fetch` — `/claim`, `/token`, `/p/{rv}/{slot}` and
  `/g/{group}/{rotate,keys,push,pull,ack}` — for a request whose `Origin` is on that list: a
  pre-flight answered `204` before the limiter, D1, the HMAC and any object, and
  `Access-Control-Allow-Origin` with `Vary: Origin` on every other answer, refusals included.
- **The socket ticket**: `GET /g/{group}/ws` takes its bearer from a `bearer.<access>` sub-protocol
  when there is no `Authorization` header, selects `grimoire.live.v1` in its 101 when that was
  offered, and refuses an `Origin` that is present and not on the list with a `403`.
- **The auto-response**: each group's object registers `ping` → `pong` with the runtime, so a
  browser's keepalive is answered without waking it.

**No migration, no secret, no new route path.** A request with no `Origin` and no sub-protocol —
every released desktop and Android build — is answered as before, so nothing in the field waits on
it or is changed by it. **It is an update of a Worker whose D1 holds real entitlements**, like
every deploy since the first; it is step 6 and nothing else, with step 0's last three pairs before
and after. A deploy disconnects every live socket once — true of any deploy, not of this one in
particular — and the desktop's live loop reconnects on its own backoff (`sync_engine::live`).

⚠️ **The web app's deploy comes AFTER this one, never before.** A page that asks a relay which
answers no pre-flight has every request refused by its own browser, and the engine sees a network
error with no status — not a 401 it could act on, not a 404 it could report. The relay first costs
nothing: until a page asks, no request carries an `Origin` and the new code is never entered.
`app-worker/README.md` is that deploy's runbook; "The order" below says the same thing where the
order is decided.

**A ninth half — a removed device is told (light app phase 6, step 6.3b) — is written and NOT
deployed.** Written 2026-10-04. What the next deploy carries, beside anything above that is still
waiting:

- **A rotation's roster closes the sockets of the devices it leaves out**, with `4001` — the
  code `drop` has always closed a whole group's with. `group.ts`'s `roster` asks `log.ts`'s
  `removedSockets` which: every open socket whose device the adopted manifest does not name.
  Until now a rotation closed nothing, and a removed device went on reading *live* over a roster
  it was no longer on until its own next round trip.
- **A device holding a socket counts as one the object knows of**, so it is marked `departed`
  with the rest even when it has not yet acked or pushed.

**No migration, no secret, no var, no route.** Internal to the Durable Object: `/roster` is still
reached only by the Worker, from inside an accepted `/rotate`.

**There is no probe for it without a credential** — nothing an outsider can ask shows whether a
roster closes sockets. With a membership it is one look: pair two devices, remove one from the
other, and **watch the removed one's Sync panel without touching it** — within about five
seconds it reads *not paired yet* (after a moment of *Not connected to the relay*). Left reading
its old roster until *Sync now* is pressed, the relay answering is the old one.

**Each side with the other's old build:**

| Relay | Client | A removed device | A device that presses *Leave group* |
| --- | --- | --- | --- |
| old | released, or new | is told nothing, as today: it learns at its next round trip. **A new client then lets go of its socket** at that trip's commit and reads `off`; a released one keeps the socket, reading `live`, until it ends by itself | a new client lets go of its socket at once and reads `off`; a released one keeps it — for up to its twelve hours, on the group it left, which is the defect step 6.3b is about |
| new | new | socket closed `4001` → `offline` for one backoff (2–4 s) → the round trip a reconnect starts with finds the manifest without it and clears the group → `off`. One `live` row in its Errors panel | socket closed `4001`, read behind its own departure: `off` at once, no row |
| new | released | the same close, and the same trip clears the group — then the released loop still tries to dial, fails for want of a group, and reads `offline` through a second backoff (4–8 s) before `off`. Up to two `live` rows | **the relay alone fixes the twelve-hour socket**: the close ends it. The released loop reads its own departure as a removal — a few seconds of `offline` and one `live` row saying the group no longer exists — and then `off` |

So the two ship in either order, and nothing in the field breaks on either. What a released
desktop pays for the new relay is a spurious row in its Errors panel when it leaves a group; what
it gets is not listening to a group it left.

A deploy disconnects every live socket once, as every deploy does. It is step 6 and nothing else,
with step 0's probes before and after.

Designs: [2026-08-29-hosted-relay-and-patreon-design.md](../superpowers/specs/2026-08-29-hosted-relay-and-patreon-design.md),
[2026-08-30-group-wide-membership-and-removal-design.md](../superpowers/specs/2026-08-30-group-wide-membership-and-removal-design.md),
[2026-08-30-leave-group-and-device-caps-design.md](../superpowers/specs/2026-08-30-leave-group-and-device-caps-design.md)
and [2026-08-31-one-sided-pairing-and-qr-design.md](../superpowers/specs/2026-08-31-one-sided-pairing-and-qr-design.md).

**No agent may run any of this unless Markus has asked for that deploy.** `wrangler dev --local`
is the only wrangler command an agent may run unasked — it runs workerd locally, contacts nothing
and needs no login. Everything below is Markus's, or an agent's at his ask: he asked for the
seventh half's on 2026-10-01, and **for the light app's phase 6 he asked once for the whole
phase** (2026-10-04: "you should deploy the changes we need, when we need them") — which covers
the eighth half's deploy and nothing after that phase. Whoever runs it follows every step.

---

## What exists, and what does not

| | |
| --- | --- |
| `mtg-grimoire-relay.denmark-east.workers.dev` | **live, and running the entitlement Worker.** Probed 2026-08-30: `/claim` and `/token` answer **405** to a GET (the route is there and wants POST) and **400** to an empty POST body, `/oauth/patreon/callback` **400**, `/g/{group}/pull` **401** from the bearer gate, `/g/{group}/push` and `/g/{group}/ack` **405**, and `/nonsense` **404** — so the gate, the callback and the membership flow are all deployed. |
| The **group-key routes** | **deployed, later the same day.** `/g/{group}/rotate` answers **401** to a POST and `/g/{group}/keys` **401** to a GET carrying a well-formed bearer, against a host where `/g/{group}/bogus` is still **404** — so these are refusals from the handlers, not a router shrug. ⚠️ **This row said "not deployed, both answer 404" and that is history.** |
| The `group_keys` **table** | **applied.** The bearer-carrying `/keys` probe in step 2 is the test — **401 is the pass and 500 is a missing table** — and it answers 401. |
| The **device roll** | **deployed, and no route path gives it away.** The tell is a body: `POST /token {"refresh":"x"}` **with no `device`** answers **400 `that is not a device id`** (probed 2026-09-28), and the same body with `"device":"deadbeef"` answers **401** — so the 400 is the device check and not an earlier one. ⚠️ **This row said "not deployed" until 2026-09-28**, on a probe that could not tell the two apart — step 0 says why. |
| The **pairing rendezvous** | **deployed.** `GET /p/{32 hex}/offer` answers **404 with a JSON body, `{"error":"nothing there"}`** — the handler's answer after a D1 read — where the router's own 404 is plain-text `not found` and a missing `pairing_rendezvous` table would be a **500**. `GET /pair` answers **200**. |
| The **refresh-secret change** | **deployed 2026-09-28**, from `main` at `1512ea68`, after `refresh_device` was added. No probe without a credential can see it; step 6 has the read that can. |
| Issue #546's **half** | **deployed 2026-09-28 at 19:57 UTC, and no public route path gives it away.** The tell is a query parameter: `/g/{group}/keys?device=…&epoch=x` with any well-formed bearer answers **400 `that is not an epoch`** from this tree — `handleKeys` checks the epoch's shape before the credential's value — and **401** from a Worker that ignores `epoch`. **Probed 2026-10-01: 400.** ⚠️ **This row said "not deployed" until then**, with a probe read off the code and never run. From inside a group the same fact is a `/keys` 200 that carries `removalStep: 2`. |
| Issue #548's **`dev` claim** | **deployed 2026-10-01**, from `main` at `2b845048`. No probe without a credential can see it. |
| The **rate limits** | **deployed 2026-10-01 at 22:09 UTC.** `settings` on the script lists `RL_CLAIM`, `RL_MINT` and `RL_READ` as `ratelimit` bindings, and a 400-request flood at `/claim` drew 347 `429`s. No small probe can see them — sixteen requests against a limit of ten drew none. Step 8 has the measurement. |
| The **browser's half** — CORS, the socket ticket, the auto-response | **not deployed.** `OPTIONS /token` with `Origin: https://mtg-grimoire.app` and `Access-Control-Request-Method: POST` answered **405** on 2026-10-04 at 15:49 UTC, where this tree answers **204**; the same request from `https://example.com` answered 405 too, which it does on both sides of the deploy. An upgrade to `/g/abc/ws` from `Origin: https://example.com` answered **401**, where this tree answers **403**. Step 0's last three pairs are the probes. |
| The D1 database | **exists.** `wrangler.jsonc`'s `database_id` is a real uuid, and has been since before this branch. It holds live entitlement rows, so step 2's `ALTER TABLE`s run against real data. `sqlite_master` listed `entitlements`, `claim_codes`, `group_keys`, `group_devices` and `pairing_rendezvous` on 2026-09-28, beside D1's own `_cf_KV`. **On 2026-10-01** `entitlements` carried fourteen columns, `refresh_device` and `reconciled_at` among them, with both CHECKs of item 5 in its stored SQL and the `entitlements_reconcile` index beside it — and the share Worker's `shares` table was added that day. |
| The Patreon OAuth app | **the client exists.** `PATREON_CLIENT_ID` is real in `entitlement.rs` since `a0eb0c6` (2026-08-30) and was verified live: `GET /oauth2/authorize` with it and `/oauth/patreon/callback` answered 302 to Patreon's login, preserving both parameters, which an unregistered id or an unregistered redirect does not do. **`wrangler.jsonc`'s `vars` carry the relay's own copy of it and `PATREON_CAMPAIGN_ID`**, both real, the client id byte for byte equal to the Rust constant. |

A device pointed at that host today reaches a relay that speaks the whole membership flow, the
whole log, the key distribution, the device cap and the pairing rendezvous. **As of 2026-10-04,
one thing in `relay/` is undeployed — the browser's half, the table's last row — and the host
still runs the 2026-10-01 22:09 UTC deploy, `claude/relay-rate-limits` at `7f6d6f50`.** Until that
day this sentence read "nothing in `relay/` is undeployed". It is the sentence on
this page most certain to rot, because the next branch that touches `relay/` makes it false
without editing it — the last two that did each left it wrong, once in each direction, and the
two since each edited it in the change that made it false. Step 0
is the authority, not it; so is `deployments` on the script, which dates every deploy whether or
not anybody wrote one down.

⚠️ **The first two rows above were the opposite until 2026-08-30, in four files at once**, and no
build could go red for any of it. The claim "the hosted Worker is not deployed" was written once
and then repeated into `CLAUDE.md`, `src-tauri/CLAUDE.md` and `relay/README.md` — where it was read
back as corroboration. Two `curl`s settled it in a second. ⚠️ **And then it happened again inside
one day**: the group-key deploy landed, and the "both answer 404" row survived in this file and in
the three others until somebody probed again. **That is what step 0 is for, and it is the reason
it comes before everything else. Probe, then read; never the other way round.**

⚠️ **Two things are called "the relay" at one hostname, and every sentence in this file is about
telling them apart.** The **baseline** relay is the three unauthenticated endpoints; the
**hosted** relay is everything else. `docs/reference/sync.md` records a 2026-08-29 pass in which
two devices converged "over the deployed relay" — that was the baseline one, pointed at by
hand through `sync_state.relay_url`, and it remains the only pass two real devices have driven end
to end. **The hosted code has since run**, which is what the table's first three rows say, but
nothing has driven a second device across it. The distinction is exactly the kind that rots, and a
deploy is expensive to get wrong, **so step 0 below settles it by asking the host rather than by
reading any of us.**

---

## The order

⚠️ **The refresh-secret change ships in three moves, and the app goes first**: an app release
carrying `entitlement::refused_secret`, then step 2's `refresh_device` migration, then step 6's
deploy. The relay change makes a refresh-door 401 an ordinary event — every `/claim` replaces the
secret, and a rotation retires one whose holder its manifest omits — and an app build without
`refused_secret` (0.30.1 and earlier) answers every such 401 by clearing its grant and showing
*Membership ended* over a live pledge. `refused_secret` asks the group door before concluding
anything, and **it is safe against the relay that is live today**: that relay only refuses a
refresh secret when a membership has ended or was never claimed, and then its group door refuses
too — a `dead` row settles to 401 whatever auth reaches it, and a group claimed before
`group_keys` has no auth to match — so a new build revokes exactly where an old one does. The
other client-visible change, `/rotate` no longer taking the refresh secret, costs nothing: no
build has ever sent one there. **All three moves are done**: v0.31.0 (2026-09-27) is the first
release carrying `refused_secret`, and the column and the deploy both landed on 2026-09-28.

**Issue #546's half ships in either order, app or relay first, and neither waits for the other.**
Every new client behaviour falls back against a relay without it: the app steps a removal or a
departure by two only after a `/keys` answer has carried `removalStep: 2`, so against the live
relay it goes on publishing `+1`, the only step that relay accepts; the live relay ignores
`?epoch=` and answers the newest manifest, which the app detects by the answered epoch not being
the one it asked for; and a relay that sends none of the new codes reaches none of the code paths
that read them. The other way round, the updated relay still accepts the `+1` every older build
publishes, and its new push refusals reach an older build as the ordinary push failure it already
retries. Most are pushes the group should never have accepted — under a key the device was removed
from, at an epoch no rotation reached, with a clock more than a day fast, one op too large to
store. The one an honest older build can meet is a `stale_epoch` from a rotation that landed
between its key check and its push, and the next trip's key check clears it, as it clears any
catch-up — reasoned from the trip's order, `check_keys` before `push`, and not driven. **What
either half alone does not buy is the lapse fix**: a device that only ever uses the group door
learns its membership ended only once this relay sends `membership_ended` *and* its build reads it.
Until both are out, that device goes on saying *Supporting since …*, as it always has.

⚠️ **The browser's half ships relay first, web app second, and that order is not a preference.**
The other way round, the web app at `https://mtg-grimoire.app` asks a relay that answers its
pre-flight with a 405 and no `Access-Control-Allow-Origin`: the browser refuses to send the real
request, every route fails alike, and the engine is told nothing but that the network failed — so
a signed-in reader sees sync as unreachable, on a page that was deployed minutes ago. Relay first
is inert until a page asks: a native client sends no `Origin`, takes neither new step, and is
answered by the same code path as today. **Neither side waits on an app release** — no desktop or
Android build sends an `Origin` or a sub-protocol, and none ever needs to.

0. **Ask the host what is actually there, and branch on the answer rather than on this file.**
   Six `curl`s settle it in ten seconds and cost nothing:
   ```
   H=https://mtg-grimoire-relay.denmark-east.workers.dev
   curl -si "$H/token" -d '{}'
   curl -s -o /dev/null -w "%{http_code}\n" \
     -H "authorization: Bearer $(printf 'ab%.0s' {1..32})" "$H/g/abc/keys?device=deadbeef"
   curl -si "$H/token" -d '{"refresh":"x"}'
   curl -si "$H/token" -d '{"refresh":"x","device":"deadbeef"}'
   curl -si "$H/p/$(printf '0%.0s' {1..32})/offer"
   curl -si -H "authorization: Bearer $(printf 'ab%.0s' {1..32})" "$H/g/abc/keys?device=deadbeef&epoch=x"
   ```
   **As of 2026-10-01 the answers are `400 malformed token request`, `401`,
   `400 that is not a device id`, `401 unauthorized`, `404 {"error":"nothing there"}` and
   `400 that is not an epoch`** — a Worker with every table applied and the device roll, the
   rendezvous and issue #546's half all deployed. All six were run that day, before and after its
   deploy; until then the sixth had never been run and this line expected `401` from it. Read them
   in that order and branch:
   - **404 on the first** means the baseline Worker is still there and none of this has run: do
     every step below.
   - **500 on the second** means the router is deployed and `group_keys` is **missing** — the
     exact state the 2026-08-30 deploy produced. Go to step 2's migration block. **401 is the
     pass**: the credential was well-formed, reached the D1 read and matched nothing. A bare
     `curl` with no header answers 401 either way, because `handleKeys` refuses a missing
     credential before it touches D1, which is what makes the header the whole point of this
     probe.
   - **The third and fourth are one question asked twice.** `400 that is not a device id` on the
     third with `401` on the fourth means the device roll is deployed and its `group_devices`
     migration must already have been applied; **401 on both** means it is not, and step 2's
     `group_devices` block is still owed. The fourth is the control: it differs from the third by
     that one field, which is what proves the third's 400 came from the device check.
   - **The fifth** answers **404 with a JSON body** when the rendezvous is deployed with its
     table, **404 with plain-text `not found`** when the route is not deployed at all — the
     router's own answer, the same one `/nonsense` gets — and **500** when the route is there and
     `pairing_rendezvous` is not.
   - **400 `that is not an epoch` on the sixth** means issue #546's half is deployed, and
     `reconciled_at` must already be in D1 — check it with step 2's `SELECT`, because a Worker
     without it looks healthy to every device. **401** means it is not deployed. The probe works
     because `handleKeys` refuses a malformed epoch before it reads D1 for the credential, and a
     Worker that ignores `epoch` never gets past the credential; it is read off the code, since the
     sandbox it was written in could not reach the host that day. A device inside a group sees
     the same fact as `removalStep: 2` on its own `/keys` answers.

   ⚠️ **The third probe is a body and not a path, and that is the lesson of the second deploy.**
   The device cap adds no route, so a route list cannot tell you whether it is live — and a route
   list is exactly what everybody reached for the first time. Do not skip this step because the
   table above agrees with you; the table is prose and prose rots, and `curl` does not.

   ⚠️ **And a body probe must pass every check that runs before the one it means to ask.** Until
   2026-09-28 the third probe here was `{"group":"aaaaaaaa","auth":"bbbbbbbb"}`, and the group door
   refuses an `auth` that is not 64 hex (`RELAY_AUTH`) as `400 malformed token request` before it
   reads `device` — as it already did in `69a0d7f`, the tree that wrote the probe. So it answered
   `malformed` against every build with a group door, device roll or none, and could never answer
   the `that is not a device id` this step promised; the device roll was live for four weeks while
   this page said otherwise. `{"refresh":"x"}` has nothing to fail but being a non-empty string,
   and `device` is the next thing the refresh door reads. **Pair every body probe with a control
   that differs by one field**, as the fourth does — a refusal read alone may come from an earlier
   check than the one you meant.

   **Three more pairs, for the browser's half — and what they ask is a header, not a path or a
   body.** Each is a probe and its control, differing by the `Origin` and nothing else; all six are
   a `GET` or an `OPTIONS` that is answered before the rate limiter, D1 and any Durable Object, so
   they spend six Worker requests and nothing more.
   ```
   H=https://mtg-grimoire-relay.denmark-east.workers.dev
   A='Origin: https://mtg-grimoire.app'
   X='Origin: https://example.com'
   # (a) the pre-flight, then its control
   curl -si -X OPTIONS "$H/token" -H "$A" -H 'Access-Control-Request-Method: POST'
   curl -si -X OPTIONS "$H/token" -H "$X" -H 'Access-Control-Request-Method: POST'
   # (b) a refusal a page can read, then its control
   curl -si "$H/g/abc/pull" -H "$A"
   curl -si "$H/g/abc/pull" -H "$X"
   # (c) the socket's origin check, then its control
   W=(--http1.1 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13'
      -H "Sec-WebSocket-Key: $(printf 'a%.0s' {1..22})=="
      -H 'Sec-WebSocket-Protocol: grimoire.live.v1, bearer.x')
   curl -si "${W[@]}" "$H/g/abc/ws?device=deadbeef" -H "$X"
   curl -si "${W[@]}" "$H/g/abc/ws?device=deadbeef" -H "$A"
   ```
   | | Before the deploy — **run 2026-10-04, 15:49 UTC** | After it — ⚠️ **not yet run** |
   | --- | --- | --- |
   | (a) from the app | `405`, `allow: POST`, no `access-control-` line | **`204`**, `access-control-allow-origin: https://mtg-grimoire.app`, `access-control-allow-methods: POST`, `access-control-allow-headers: authorization, content-type`, `access-control-max-age: 86400`, `vary: Origin` |
   | (a) control, from `example.com` | `405`, `allow: POST` | the same `405`, and **no** `access-control-` line |
   | (b) from the app | `401`, no `access-control-` line | `401` **with** `access-control-allow-origin: https://mtg-grimoire.app` and `vary: Origin` |
   | (b) control | `401` | `401`, and **no** such line |
   | (c) from `example.com` | `401` | **`403`** `origin not allowed` |
   | (c) control, from the app | `401` | `401` — the origin passes, and `bearer.x` is no token |

   - **405 on both of (a) is how "not deployed yet" reads**: a Worker without this half has never
     heard of either origin and gives each the router's method refusal. **204 on the first with
     405 on the second** is the half deployed *and* its list holding. **204 on both** would be a
     relay that reflects any origin — stop and read `APP_ORIGINS` on the script's `settings`
     before anything else. **405 on both after a deploy** is `APP_ORIGINS` unset or misspelled on
     the script — a trailing slash is enough — and (c) then answers `403` to the app's own origin
     too, which is the tell that separates it from a deploy that did not land.
   - **(b) is the one that matters to the app and the one (a) cannot stand in for.** A relay that
     answered every pre-flight and left the header off its refusals would pass (a) and turn every
     401, 403, 409 and 429 into a network error in the page. A `GET` to the bearer gate, because
     it is the refusal that costs nothing: no limiter, no D1.
   - **(c) asks about the origin check, and the ticket itself has no tell without a credential** —
     the refresh-secret change's position exactly. `bearer.x` is refused by a relay that reads the
     sub-protocol (it is no token) and by one that does not (there is no header), with the same
     `401`; that is the control's row, and it is why the probe is the *foreign* origin, which only
     this tree refuses with a `403`. That the ticket opens a socket is proved by the web app's
     socket opening and by nothing here. ⚠️ **The probe first proposed for this step was the ticket
     alone, expecting `401` after the deploy** — the answer it also gets before one.
   - `--http1.1` because an upgrade is an HTTP/1.1 request; without it `curl` may negotiate
     HTTP/2 and drop `Connection` and `Upgrade`. Header names print in whatever case the edge
     sends, so read them case-insensitively.
1. **`npx wrangler d1 create mtg-grimoire-relay`**, then put the real `database_id` into
   `relay/wrangler.jsonc`.
2. **Apply the schema to an empty database**, and verify rather than trusting exit 0 —
   see [the CHECK trap](#the-check-constraints-are-a-one-shot) below.
   ```
   npx wrangler d1 execute mtg-grimoire-relay --remote --file=./schema.sql
   ```
   ⚠️ **That command is for an empty database only. On any other, use the migration below.**

   `wrangler d1 execute --file` is **atomic**: one failing statement rolls back every statement
   in the file. `schema.sql` ends with two `ALTER TABLE ... ADD COLUMN`, D1 has no
   `ADD COLUMN IF NOT EXISTS`, and a duplicate column is an error — so on a database that already
   has `group_epoch` and `group_auth`, those two `ALTER`s fail and **take `CREATE TABLE
   group_keys` down with them**, even though the CREATE comes first and would have succeeded.

   **This is measured, not theoretical.** On the 2026-08-30 deploy `wrangler deploy` landed and
   the execute reported nothing wrong, and `/g/{group}/keys` went from 404 to a **500** —
   `authIsRecent`'s `SELECT auth FROM group_keys` throwing `no such table` against a Worker that
   had just been told the schema was applied. An earlier draft of this step said the re-run error
   was one to "expect and ignore". It is not ignored; it reverts.

   **To bring an existing database forward**, which is every database that is not brand new:
   ```
   npx wrangler d1 execute mtg-grimoire-relay --remote \
     --file=./migrations/2026-08-30-group-keys.sql
   npx wrangler d1 execute mtg-grimoire-relay --remote \
     --file=./migrations/2026-08-30-group-devices.sql
   npx wrangler d1 execute mtg-grimoire-relay --remote \
     --command "ALTER TABLE entitlements ADD COLUMN group_epoch INTEGER"
   npx wrangler d1 execute mtg-grimoire-relay --remote \
     --command "ALTER TABLE entitlements ADD COLUMN group_auth TEXT"
   npx wrangler d1 execute mtg-grimoire-relay --remote \
     --command "CREATE TABLE IF NOT EXISTS pairing_rendezvous (rv TEXT NOT NULL, slot TEXT NOT NULL CHECK (slot IN ('offer', 'join')), blob TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (rv, slot))"
   npx wrangler d1 execute mtg-grimoire-relay --remote \
     --command "ALTER TABLE entitlements ADD COLUMN refresh_device TEXT"
   npx wrangler d1 execute mtg-grimoire-relay --remote \
     --command "ALTER TABLE entitlements ADD COLUMN reconciled_at INTEGER"
   npx wrangler d1 execute mtg-grimoire-relay --remote \
     --command "CREATE INDEX IF NOT EXISTS entitlements_reconcile ON entitlements (reconciled_at, subject) WHERE status <> 'dead'"
   ```
   Both migration files are `IF NOT EXISTS` throughout and safe to run any number of times. Each
   `ALTER` is its own invocation so a `duplicate column name` — the correct answer on a database
   that already has it — costs nothing else.

   ⚠️ **`reconciled_at` and its index (`relay/migrations/2026-09-28-reconciled-at.sql`) go in
   BEFORE the deploy that ships the budgeted `reconcile`, as two `--command`s in that order** — the
   index names the column — and never as `--file`, which on a database the `ALTER` has already
   reached would roll the index back with the duplicate-column error. **A Worker without the column
   fails quietly rather than loudly**: nothing a device calls reads it, so sync is untouched and
   every probe above looks healthy, but every hourly `scheduled` throws on its `SELECT` — no subject
   is reconciled, and the rendezvous sweep that runs after it never runs either. So check it landed,
   against the host, before step 6:
   ```
   npx wrangler d1 execute mtg-grimoire-relay --remote \
     --command "SELECT reconciled_at FROM entitlements LIMIT 0"
   ```
   An empty result is the pass; `no such column` means the `ALTER` did not run. A missing index
   costs speed and nothing else. The column is additive: every existing row reads NULL, which the
   pass reads as *never reconciled* and puts at the front of the queue — so the first hourly passes
   after the deploy work through the whole live table twenty rows at a time, reaching subjects the
   daily pass never got to, and settle into about one turn a subject a day once they have.

   **The Durable Object's half of issue #546 needs no step here, and that is also why it is
   untested.** Its new column (`acks.heard_at`) and tables (`departed`, `roster_epoch`, `log_size`)
   are made by each object's own constructor on its first wake after the deploy: `CREATE TABLE IF
   NOT EXISTS` for the tables, and `ALTER TABLE acks ADD COLUMN heard_at` when `PRAGMA
   table_info(acks)` does not list it, backfilled with that moment so every existing device counts
   as heard at the deploy. **Whether workerd accepts that `PRAGMA` has never been run** — every
   constructor asks it, so if it does not, every request that reaches any group's object 500s while
   `/token`, `/rotate` and `/keys` answer normally. **The first pull after the deploy is the check**;
   see item 12 below.

   ⚠️ **`refresh_device` (`relay/migrations/2026-09-26-refresh-device.sql`) must be applied BEFORE
   the deploy that reads it**, and a Worker without it fails quietly rather than loudly:
   `/claim`'s binding `UPDATE` throws, is caught as if it were the unique violation, and answers a
   misleading **409** *after* the claim code is spent; `/rotate` records the new epoch and then
   **500s**, skipping `keepOnly`. So check it landed, against the host, before step 6:
   ```
   npx wrangler d1 execute mtg-grimoire-relay --remote \
     --command "SELECT refresh_device FROM entitlements LIMIT 0"
   ```
   An empty result is the pass; `no such column` means the `ALTER` did not run. **Applied
   2026-09-28**: the `ALTER` answered with no `duplicate column name`, so the column had never
   been there, and this `SELECT` answered empty. The column is
   additive — every existing row reads NULL, which `/rotate` treats as *holder unknown*, so the
   group's next accepted rotation retires that row's secret. What that costs the paying device,
   if it is still in the group, is one 401 on `/token`'s refresh door, which a build carrying
   `entitlement::refused_secret` answers silently by minting through the group door — the reason
   the app release comes first.

   ⚠️ **`relay/migrations/2026-08-31-pairing-rendezvous.sql` is run as its own `--command`, never
   through `--file`, even though the checked-in file holds only this one statement.** The file
   exists for the same reason the other two do — a readable record of the SQL — but this step's own
   opening paragraph is the reason not to point `--file` at it: an atomic multi-statement execute is
   what turned a harmless re-run into the 2026-08-30 outage, and the fix adopted here is to never
   give `--file` a second chance at that failure mode rather than to argue this particular file is
   safe because it happens to hold one statement today.

   ⚠️ **`group_devices` must be applied BEFORE the deploy that ships `admitDevice`, not after.**
   Both `/token` doors call it on every trip, so a Worker pointed at a database without the table
   answers **500 on the route every device uses to sync**. The reverse order costs nothing: a
   table nothing writes to yet is inert. That is the only ordering constraint this half adds, and
   it is the opposite of the group-key half's, where the missing table was discovered *after* the
   deploy because nothing on the hot path read it.

   **Then verify against the host rather than against an exit code**, which is the whole lesson
   of this step:
   ```
   curl -s -o /dev/null -w "%{http_code}\n" -H "authorization: Bearer $(printf 'ab%.0s' {1..32})" \
     "https://mtg-grimoire-relay.denmark-east.workers.dev/g/abc/keys?device=deadbeef"
   ```
   **401 is the pass** — the credential was well-formed, reached the D1 read, and matched nothing.
   **500 means `group_keys` is missing.** A bare `curl` with *no* header answers 401 either way,
   because `handleKeys` refuses a missing credential before it touches D1 — so the header is what
   makes this probe worth running.

   ⚠️ **Every group that synced before this deploy stops syncing until somebody reconnects
   Patreon on it, and that is the migration.** `seedGroup` runs from `/claim` and nowhere else,
   so a group claimed before `group_keys` existed has an entitlement with a NULL `group_auth` and
   no manifest row. `client::check_keys` runs first in every round trip, `authIsRecent` finds
   nothing, and the trip dies with a 401 before push, pull or ack.

   **The relay cannot repair this itself, ever.** `relay_auth` is HKDF over the group key, which
   the relay never sees and must never see — so there is no backfill to write, and the repair has
   to be a press on a device that holds the key.

   **The press is Connect Patreon, on the device the membership was connected on.** A re-claim of
   a group that is already bound to the same subject passes `row.group_id === group`, and
   `handleClaim` then calls `seedGroup` with that device's current epoch and auth. Every other
   device in the group succeeds on its next trip, with nothing pressed on it.

   ⚠️ **"Reconnect Patreon once" does not say *which* device, and pressed on one that is behind a
   rotation it used to break the devices that were fine.** `group_keys` is keyed
   `(group_id, epoch)`, so `INSERT OR IGNORE` conflicted with nothing when a device re-claimed its
   own group at an *older* epoch: it wrote a second row down there and re-pointed
   `entitlements.group_auth` at an auth derived from a key the group had already rotated past.
   Every caught-up device then 401ed on the group door until somebody rotated again, while the
   stale row was accepted by `authIsRecent` — so the one device that should have stopped was the
   one that kept working. **That is the state Markus's own pair reached.** Fixed on this branch:
   both of `seedGroup`'s statements now refuse an epoch behind the group — and, since, one ahead of
   it or a foreign auth at its own epoch — the claim still succeeds and still mints a grant, and the key registration is left where
   it already correctly pointed. **All of it is live since 2026-09-28** — the refusals of an epoch
   ahead and of a foreign auth arrived with the refresh-secret change — so the press no longer has
   to be aimed. Until then the advice here was to press Connect on a device that had just synced
   successfully, not on the one that had been failing.

   **Measured 2026-08-30**, on the real pair and on the first press of the pass: a paid-up,
   paired device at epoch 2, `entitled: true`, `status: "active"` — and `sync_now` answering
   *the relay did not recognise this device's group key*. **No suite could have caught it**:
   every relay test starts from a group claimed under the new code, so "claimed before the
   migration" is a state the fixtures cannot express. It took a device with real history.
3. **Create the Patreon OAuth client** — **done.** The client and its redirect URI
   `https://mtg-grimoire-relay.denmark-east.workers.dev/oauth/patreon/callback` are registered and
   were verified live (see the table above), and `wrangler.jsonc`'s `vars` carry
   `PATREON_CLIENT_ID` — **byte for byte equal to `entitlement::PATREON_CLIENT_ID`**, because this
   side builds the authorize URL, the relay builds the exchange, and Patreon compares them — and
   `PATREON_CAMPAIGN_ID` beside it. Both are public.
4. **Set the three secrets.** There are three, not four.
   ```
   npx wrangler secret put PATREON_CLIENT_SECRET
   npx wrangler secret put PATREON_WEBHOOK_SECRET
   npx wrangler secret put RELAY_HMAC_KEY      # any 32+ random bytes; rotating it invalidates
                                               # every outstanding access token, which is the
                                               # intended break-glass — readers recover silently
                                               # within 24 hours on their next refresh
   ```
5. **Register the webhook** for `members:pledge:create`, `members:pledge:update`,
   `members:pledge:delete` and `members:update`, pointing at `/webhook/patreon`.
6. **`npx wrangler deploy`.** **Last run 2026-10-01 at 22:09 UTC, from `claude/relay-rate-limits`
   at `7f6d6f50`** with step 8's rate limits — after 19:17 UTC the same day from `main` at
   `2b845048`, and twice on 2026-09-28, at `1512ea68` and then with issue #546's half. **The next
   run carries the browser's half** — the list at the top of this page — with step 0's three
   `Origin` pairs before and after it, and the web app's own deploy only once they answer `204`,
   `401` with the header, and `403`. Both bullets below are
   still open. Then, for the refresh-secret change:
   - **Press Connect Patreon once on the paying device.** Not required, but it records which
     device holds the secret, so the group's next rotation keeps it rather than retiring it as
     *holder unknown* — and it spares any device still on 0.30.1 or earlier the *Membership ended*
     that build draws when its secret is refused. **It is also the only proof from outside that
     the refresh-secret change is live**, since nothing it changed answers without a credential:
     after the press, this reads at least 1, and only the new `/claim` writes the column.
     ```
     npx wrangler d1 execute mtg-grimoire-relay --remote \
       --command "SELECT count(*) FROM entitlements WHERE refresh_device IS NOT NULL"
     ```
   - **Once new builds are widespread, retire every secret no device was recorded against**, once,
     by hand — it is not automated, because a holder still on an old build reads the refusal as a
     lapse:
     ```
     npx wrangler d1 execute mtg-grimoire-relay --remote --command \
       "UPDATE entitlements SET refresh_secret = NULL, refresh_device = NULL WHERE refresh_device IS NULL AND refresh_secret IS NOT NULL"
     ```
     Until then a legacy secret still opens `/token`'s refresh door for whoever holds it, until
     the group's next rotation or its holder's next Connect press.
7. **Add the free-tier ceiling alarm** — a Cloudflare notification at ~70% of the 100 000/day
   request cap. Decided 2026-08-29: stay free, watch the ceiling. The ceiling is a **cliff, not a
   slope** — past it *every* reader errors at once, so without the alarm the first signal is
   complaints. ⚠️ **Still open, and "a Cloudflare notification" turned out not to exist** (asked
   of the account and the docs, 2026-10-01): the account's notification types hold nothing for
   Workers requests, and the usage-based billing alert is for pay-as-you-go accounts. The alarm
   has to be something that reads the day's request count from the analytics API on a schedule and
   posts when it crosses — a small Worker of its own, a scheduled GitHub workflow, or a line in
   this Worker's cron. Markus put it aside that day in favour of step 8.
8. **Rate limits on `/claim`, `/token`, `/g/{group}/rotate`, `/g/{group}/keys` and
   `/p/{rv}/{offer,join}` — built and deployed 2026-10-01, in the Worker rather than as rules in
   front of it.** Deployed at 22:09 UTC, version `27776e8b`, from the branch
   `claude/relay-rate-limits` at `7f6d6f50` — ahead of its merge, so until
   [#758](https://github.com/Msgaihede/mtg-grimoire/pull/758) lands the host is one change ahead
   of `main`. It was step 6's `wrangler deploy` and nothing else: no migration, no secret, and the
   three bindings were created by the deploy that names them. The burst below is how to ask the
   host whether a later deploy still has them. ⚠️ **This step said "add rate-limiting rules", and a rule is the one thing this host cannot
   have**: a WAF rate-limit rule belongs to a zone, and `workers.dev` is not one the account
   controls. What stands there instead is Cloudflare's rate-limit *binding* — three `ratelimits`
   entries in `wrangler.jsonc`, asked by `relay/src/ratelimit.ts` after the method check and ahead
   of each handler:

   | Binding | Routes | Per client address, per 60 s | Heaviest honest use |
   | --- | --- | --- | --- |
   | `RL_CLAIM` | `/claim` | 10 | one per Connect press |
   | `RL_MINT` | `/token`, `/rotate` | 30 | a device mints about once in eighteen hours |
   | `RL_READ` | `/keys`, `/p/{rv}/{slot}` | 240 | one `/keys` per sync trip; a pairing dialog polls every 1.5 s — 40 a minute, 80 for a pair behind one address |

   A caller past its limit gets **`429 {"error":"too many requests","code":"rate_limited"}`** with
   `retry-after: 60`, before any D1 read. **Never a 401**: the app reads a 401 on these routes as a
   statement about a membership, and it reads a 429 as an ordinary failure it retries — `the relay
   answered 429 to /token`, no grant revoked (`entitlement.rs`'s `post`, `client.rs`'s key check).
   **It fails open twice** — a binding that is absent and a binding that throws both let the
   request through — so a limiter can never be what stops sync.

   ⚠️ **What it does not do is keep junk off the 100 000-a-day budget.** The Worker has been
   invoked by the time it asks, so a refused request still counts; only the D1 read is spared.
   Step 7's alarm is still the only thing that would see the cliff coming, and the only fix that
   refuses a request before it is counted is a custom domain with a zone rule in front of it —
   which moves `RELAY_BASE` and the Patreon redirect URI, and is not planned.

   ⚠️ **Cloudflare counts per location and eventually, and that is far looser than the number
   reads.** The binding is, in its own documentation's words, "permissive, eventually consistent"
   and not an accounting system. **Measured against the live Worker straight after the deploy, one
   machine, `POST /claim` with an empty body, limit 10 a minute:**

   | Sent | Refused |
   | --- | --- |
   | 16, one after another over a few seconds | **0** |
   | 70 more inside the same minute, 60 of them twelve at a time | **2** |
   | 400, forty at a time, in 8 s | **347** |
   | 20 one after another straight after that | **20** |

   So it **bounds a flood and does not meter a trickle**: a caller at a request or two a second
   went eight times past the limit and met two refusals, and a caller at fifty a second was refused
   seven times in eight and then every time. That is the right shape for what this step is for —
   the D1 reads a trickle costs are noise, and a flood's are the bill — and it means an honest
   reader has far more headroom than the table above says. It also means **a limit here is never a
   promise about the eleventh request**, and nothing may be built on it being one.

   ⚠️ **The deploy check this step first carried could not pass**: it sent fifteen requests and
   said that all-400 means no limiter is bound. Fifteen is the first row of that table — a working
   limiter answers all-400 to it. The check that can tell is the flood, and the `/token` beside it
   is the control showing another bucket was not spent:
   ```
   H=https://mtg-grimoire-relay.denmark-east.workers.dev
   seq 1 400 | xargs -P 40 -I{} curl -s -o /dev/null -w "%{http_code}\n" "$H/claim" -d '{}' | sort | uniq -c
   curl -s -o /dev/null -w "%{http_code}\n" "$H/token" -d '{}'
   ```
   **A few dozen `400`, a few hundred `429`, then `400` from `/token`.** All `400` from a burst
   that size means no limiter is bound — a Worker deployed before this step, or the fail-open arm,
   which is also what a binding name that drifted from `ratelimit.ts` looks like;
   `ratelimit.test.ts` reads `wrangler.jsonc` to hold the names and numbers together, `wrangler
   deploy` prints the three bindings it attached, and `settings` on the script lists them as
   `ratelimit`. **It spends 400 of the day's 100 000 requests and refuses `/claim` from that
   address for about a minute**, so it is a check for a deploy that touched the limiter, not one
   to run for reassurance. Never aim it at `/keys`: that locks your own devices out of sync.

   The bill argument in `index.ts` — "junk is refused for the price of a
   Worker invocation alone" — holds for the three routes behind the bearer gate and **not** for
   these five, which each cost a D1 read before anything can refuse them. ⚠️ **This step named two
   until 2026-08-30, and four until 2026-08-31**: `/rotate` and `/keys` are `/g/…` routes that
   deliberately stand *ahead* of the gate, because a device that has just been rotated away from
   cannot mint a token and `/keys` exists to answer exactly that device; `/p/{rv}/{slot}` is the
   pairing rendezvous, unauthenticated by design because the joining device has no token yet either.
   None of the five reaches a Durable Object to refuse anything — `/rotate` reaches one only once D1
   has accepted a rotation, to post its roster, and only a caller holding the group's current auth
   gets that far — so the metered line is untouched by junk. But "unauthenticated at the edge" is
   what a rate-limit rule is about, and by that test they belong on this list rather than on the
   other one.

---

## What only the deploy can settle

**Thirteen things**, in the order they will bite. ⚠️ **Re-counted 2026-10-04** — it was twelve
until the browser's half added item 13, eleven until issue #546's half added item 12, ten until
the device roll added item 11, and nine until the group key store added item 10.

### 1. `include=memberships.campaign` — the highest-value check here

**The spec originally prescribed `include=memberships&fields[member]=patron_status`, and that can
strip the campaign relationship**: `fields[member]` is a JSON:API *sparse fieldset*, and
relationships are fields. Every supporter would then match no campaign, resolve to `dead`, and be
told they are not supporting — **with the OAuth flow completing successfully and nothing erroring
anywhere.** The fix is reasoned from JSON:API's full-linkage rule, not observed.

Drive one real callback and confirm the returned document carries
`relationships.campaign.data.id` on the member object.

### 2. The redirect URI, at both matching points

`entitlement::RELAY_BASE`, `wrangler.jsonc`'s `RELAY_BASE` var, and what is registered with Patreon
must be identical. A trailing slash on any one of them fails the **code exchange** with
`invalid_grant` — an error that names no path and reads like a credential problem.

### 3. The unit, end to end

Complete one real claim, then read `sync_state.access_expires` on the device. **It must be ~10
digits, not ~13.** The relay counts milliseconds internally and the app counts seconds; if
milliseconds reached the app, `expires - now` would always exceed the refresh margin, the token
would never refresh, and the relay would 401 every sync request a day later — on the sync route,
where nothing is watching. `store_grant` refuses milliseconds loudly, so a wrong unit shows up as a
claim that *fails* rather than a sync that dies. Confirm which you get.

### 4. Two D1 behaviours nothing has executed

- `DELETE … RETURNING` read through `.first()` — **the single-use guarantee of a claim code rests
  on it.** D1 has no interactive transaction, so read-then-delete could not have been made safe.
- `bound.meta.changes` being present and non-zero on the trust-on-first-use `UPDATE` that binds a
  group.

### 5. The CHECK constraints are a one-shot

**Every `CREATE` in `schema.sql` is `IF NOT EXISTS`**, so applying it to a database where
`entitlements` already exists is a silent no-op — and the `status` and `grace_until > 0`
constraints never arrive. Apply to an **empty** database, then verify with `PRAGMA table_info` or
`sqlite_master` rather than trusting exit 0. Free today; a table rebuild after the first apply.

**The same shape decides which branch step 0 puts you on.** If the D1 database already exists —
because some version of this design is deployed — then re-running the file gets you the `CREATE`s
as no-ops and the two `ALTER TABLE`s as either real work or `duplicate column name`. That is
survivable and is what the runbook expects. **What it does not fix is a missing CHECK**: a
database created before the constraints landed keeps a `status` column that will take any string,
for ever, and no error anywhere says so. So verify the constraints by reading
`sqlite_master.sql` for `entitlements`, whichever branch you are on, and treat a missing
`CHECK (status IN …)` as a table rebuild rather than as something to apply the file again over.

### 6. `AUTOINCREMENT` surviving a `drop`

`group.ts` relies on `sqlite_sequence` keeping the high-water mark, so that a revoked-then-
reconnected device holding a stored `pull_cursor` does not silently skip rows. Correct in SQLite
and documented in the constructor; unverified in workerd's SQLite-backed Durable Object.

### 7. The webhook, end to end

Patreon's real `X-Patreon-Signature` against the hand-written HMAC-MD5 (Workers exposes MD5 to
`subtle.digest` but not to HMAC, so it is built from two digests and pinned to RFC 2202 vectors).
Confirm the `X-Patreon-Event` header actually arrives, or `:delete` is never recognised.

**This is the one route where failing open destroys data** — an unverified `pledge:delete` deletes
a reader's log. An unset `PATREON_WEBHOOK_SECRET` is a deliberate 500 rather than a pass, because
`hmacMd5` would otherwise accept an empty key.

### 8. The secrets before first traffic — **settled for two of the three, 2026-08-30**

`RELAY_HMAC_KEY` unset makes every authenticated request a 500. That is deliberate — `token.ts`
does not catch it, on the grounds that an unset key should be loud rather than silently 401ing
every reader.

**Which is exactly what makes it probeable, and it passes.** A `/g/{group}/pull` carrying a
*malformed* bearer answered **401**, and the gate calls
`required(env.RELAY_HMAC_KEY, "RELAY_HMAC_KEY")` before `verify` can refuse it — so an unset key
could only have been a 500. ⚠️ **A bearer-less probe proves nothing here**: the header is coalesced
to `null` and `required` is never reached, so it 401s either way. Same shape for
`PATREON_WEBHOOK_SECRET`: `handleWebhook` calls `required` unconditionally ahead of
`verifyWebhook`, and a signature-less POST answered **401**. `PATREON_CLIENT_SECRET` is reachable
only through a real code exchange and remains unsettled.

### 9. The three sentences, on a real device

*Not connected* → *Supporting since …* → *Payment problem* → *Membership ended*. The last is the
one that carries "your local data is untouched", and it was unreachable twice during
implementation. Cancel a real pledge and confirm the panel says **Membership ended**, not *Not
connected*.

### 10. The group key store, and the one failure that costs a healthy group

Added 2026-08-30. Four things, and the third is the one to be frightened of.

- **`/token`'s group door, on a device that has only ever paired.** Pair first, connect second,
  and watch the second device reach *Supporting since …* without being touched. That is the whole
  of the reason the refresh secret left the pairing blob, and no test can reach the real
  `/token`.
- **`recordRotation`'s `INSERT … SELECT … WHERE`, and `meta.changes` on it.** The 409 that stops
  a removed device re-registering the epoch it remembers is `meta.changes === 0` on a conditional
  insert — the same D1 behaviour item 4 flags for the trust-on-first-use `UPDATE`, on a statement
  where a wrong answer is not a failed bind but a device walking back into a group that evicted
  it. Publish a rotation twice at one epoch and confirm the second is a 409.
- ⚠️ **A group that has claimed and never rotated must leave every device alone.** `/claim` seeds
  `group_keys` with an **empty** manifest at the claim's epoch, so every device in such a group
  reads `blob: null, devices: []` — which is byte-for-byte the removal notice. The app compares
  epochs first and does nothing on an equal one, and that guard is the only thing between a
  healthy group and every device in it dissolving the group on its next sync, all at once, for a
  reason nobody could see. **Claim, then sync twice on two devices, and confirm both still say
  they are in a group of two.** This is the highest-stakes check on the page: the failure is
  silent, simultaneous and unrecoverable without re-pairing.
- **The prune, and that it does not delete the row it just wrote.** `recordRotation` follows its
  insert with `DELETE … WHERE epoch <= ? - EPOCH_HISTORY` in the same batch. Correct by
  arithmetic for any `EPOCH_HISTORY` above zero; unverified against D1's batch semantics. After
  nine joins, confirm `group_keys` holds eight rows and that the oldest surviving auth is still
  accepted by `/keys` — **joins**, because the window is eight epochs and a removal steps over one,
  so a run of removals keeps fewer rows by design.

### 11. The device roll, and the one refusal that must not read as a lapse

Added 2026-08-30. **The code is live** — step 0's third probe, 2026-09-28 — **and none of these
four checks has been driven**, which is the state this section exists to name. Four things.

- ⚠️ **`admitDevice`'s `INSERT … ON CONFLICT (group_id, device_id) DO UPDATE`, against real D1.**
  The whole cap rests on a returning device being free: without the upsert, one device refreshing
  its token daily would spend a new slot every day and a reader would be locked out of their own
  account inside a week. The fake models the primary key so the test is not vacuous, but an
  upsert whose conflict target is not a real unique index is a **prepare-time** error in SQLite,
  and only the deploy proves the deployed table has the key the statement names. **Sign in on one
  device, sync it four times, and confirm four more devices can still pair.**
- ⚠️ **The 403 with `code: "device_limit"`, on a real sixth device.** Confirm the panel says the
  membership already covers five devices and **does not** say *Membership ended* — a cap routed
  through the 401 path calls `entitlement::revoke` and would clear a paying reader's grant. Both
  sides pin the literal `device_limit` and nothing but a live refusal checks that the two spell
  it the same.
- **The rebind, and what it destroys.** Claim a membership onto a second group and confirm the
  first group's devices stop syncing — that is the *designed* outcome and the panel warns of it
  before the press, but it is also the one operation on the relay that deletes a working group's
  log. Confirm as well that another **subject** claiming a bound group id is still a 409, which is
  the case the constraint is actually for.
- **`keepOnly` freeing a slot.** Fill a group to five, remove one device, and confirm a sixth can
  then pair — the manifest is the only thing that frees a slot inside ninety days, and the TTL is
  not something a deploy can wait out.

### 12. Issue #546's half — the object's own migration, the hourly cron, and two ceilings nobody could read

Added 2026-09-28. **The code has been live since that evening and none of these five checks has
been recorded as driven** — the state item 11 was in for four weeks. Five things, and the first is
the one that can take sync down.

- ⚠️ **`PRAGMA table_info(acks)` inside a Durable Object's constructor.** Every object asks it on
  every wake, a brand-new one included, to decide whether `acks.heard_at` still has to be added —
  there is no migration step for a Durable Object, so its schema is whatever its constructor last
  made it. Whether workerd's SQL API accepts that `PRAGMA` has never been executed; if it does not,
  the constructor throws and **every push, pull, ack and socket on every group 500s**, while
  `/token`, `/rotate` and `/keys` go on answering. **Sync one device straight after the deploy and
  confirm it pulls.** A 500 on the pull beside a healthy `/keys` is this, and the answer is the
  previous Worker. The backfill that follows it is the other half of the same statement: every
  existing ack is stamped with the migration's own moment, not zero, so no live device drops off
  the compaction floor at the deploy.
- **The hourly cron firing, and the queue moving.** Confirm in the dashboard's cron events, or
  `wrangler tail`, that `scheduled` now fires at minute `0` every hour rather than at `0 3`, and that
  `SELECT count(*) FROM entitlements WHERE reconciled_at IS NOT NULL` climbs by up to twenty an hour
  until every live row has been stamped once. A `no such column: reconciled_at` in the scheduled
  invocation's log is step 2's missing `ALTER`, and it is the only place that failure shows.
- ⚠️ **The free plan's per-invocation ceilings.** The budget of twenty is sized to **50 external
  subrequests** (a row spends two Patreon fetches — 40) and **50 D1 queries** (one `SELECT`, one
  stamp and at most two `UPDATE`s a row — 42, 43 with the rendezvous sweep) per invocation. Both
  figures are search summaries of Cloudflare's pages, which could not be read from the sandbox that
  sized the budget, and the ~25 subjects a day the old pass is said to have reached is derived from
  them rather than measured. If either ceiling is lower, a full pass fails part way through, one
  caught `reconcile <subject>` error at a time — so read the first full pass's log for a limit error
  rather than a Patreon one.
- **`/rotate`'s two-epoch step and `/keys?epoch=`, on real D1.** Both bounds are in one
  `INSERT … SELECT … WHERE ? > max AND ? <= max + ?`, where item 10's statement had one. Remove a
  device on a build that has seen `removalStep: 2`, and confirm the rotation lands two epochs on,
  that `/keys?epoch=` for the epoch it stepped over answers **404 `no_such_epoch`**, and that a
  device that stayed in the group but was dark across the removal catches up rather than leaving.
  No `rotate roster` error in the Worker's log afterwards is the pass for the roster post; nothing
  a device sees depends on it.
- **`membership_ended`, on a device that never pressed Connect.** Item 9's cancelled pledge, read
  on the *other* device: it must say **Membership ended** within one sync, where before this it
  went on saying *Supporting since …* for as long as the group door kept answering a bare 401. It
  needs this relay and a build that reads the code — see "The order".

### 13. The browser's half — a 101 no browser has read, and a keepalive nobody has seen billed

Added 2026-10-04, and deployed that day at 17:22 UTC. Step 0's three pairs
settle the CORS headers and the origin check from outside; these are what only a real browser, or
the account's own dashboard, can say. `relay/src/cors.test.ts` and `ticket.test.ts` run the
router, and the real `Group` over stand-ins for three of workerd's globals — Node's `Response`
refuses a status of 101 — so everything below is exactly what those suites could not reach.

**What the local run settled, and what only production still can** (step 6.3, 2026-10-04:
`npm run web:sync-smoke` — this relay's code under workerd, `wrangler dev --local` 4.146.0, and
two profiles of headless Chrome 154 reaching it by its real name):

| | Under workerd, in Chrome | On the deployed Worker |
| --- | --- | --- |
| The 101's `Sec-WebSocket-Protocol` reaches a browser | **yes** — both sockets read `grimoire.live.v1` and stayed open | not seen: it needs a real membership in a real browser, which is the owner's |
| The text `ping` is answered `pong` | **yes** — every `ping` either device sent, the second 45 s after the first | not seen |
| A page's requests pass CORS, refusals included | **yes** — a claim, a token, a pairing, pushes, pulls and acks, with no failed request | step 0's probes, from outside |
| The page's policy lets the socket through | only with the relay's `wss://` source in `connect-src` — `https://` alone is refused by Chrome | the web app's next deploy carries it |
| What a keepalive is billed | nothing a local run can say | the one-hour check below |
| The token in Workers Logs | nothing a local run can say | **decided, not measured**: accepted by the owner on 2026-10-04, `invocation_logs` stays on |
| Safari, Firefox, a phone's browser | not driven | not driven |

- ⚠️ **The 101's `Sec-WebSocket-Protocol`, through the Worker, to a browser.** `Group.ws()` puts
  `grimoire.live.v1` on its 101 when the request offered it, and the Worker hands that response
  back untouched. That workerd carries a header on a 101 out to the client is how every
  sub-protocol server on Workers is written and is in no page of Cloudflare's documentation that a
  search on 2026-10-04 found. **Open the web app signed in, and confirm the socket stays open**:
  one that opens and closes at once, with Chromium's console naming a sub-protocol, is this. The
  fix is in `group.ts`, and until it lands the web app has no live sync and loses nothing else:
  push, pull and ack are HTTP and never touch the socket.
- **The desktop's socket, straight after the deploy.** It offers no sub-protocol and sends no
  `Origin`, and `ticket.test.ts` holds its 101 to no header at all — but it is the client every
  reader has, and a `Sec-WebSocket-Protocol` it did not ask for is a failed handshake. **Edit a
  card on one desktop and watch a second pick it up without a press.** The Android app's socket
  is the same code since the light app's step 6.2 (`grimoire-core`'s `platform::socket`), so one
  desktop answers for both.
- ⚠️ **That the deployed edge answers a protocol ping with a pong — which the native client now
  leans on, and nobody has watched in production.** Since step 6.2 the client ends a socket whose
  ping went unanswered, once that socket has seen one pong (`platform::socket`'s `keepalive`), so
  a half-open connection is noticed in two ping periods rather than when TCP gives up. workerd
  pongs: the relay under `wrangler dev --local` answered a raw masked ping, opcode 9 and empty,
  with opcode 10 and empty, on a hibernatable socket (2026-10-04). **Leave a paired desktop on
  that build connected for three minutes and read the Sync panel**: `Live` throughout is the
  pass. A socket that drops to `Offline` every ninety seconds means the edge answered one ping
  and then stopped — the one shape the client's rule does not forgive. It leaves no `error_log`
  row to find: a socket that lived past a minute is forgiven its end (`schedule::next_attempt`),
  so the panel's state is the only tell. An edge that answers none at all shows nothing here: the
  deadline never arms, and the client is where it was before the rule.
- ⚠️ **What a tab's keepalive costs.** The pricing page bills incoming WebSocket messages at
  twenty to one and exempts protocol pings by name; of `setWebSocketAutoResponse` it says only
  that the answer costs no *duration*. Read as written, a browser's `ping` every 45 s is 1 920
  messages a day — **96 billed Durable Object requests for a tab open all day, 32 for eight
  hours** — where the desktop's protocol ping is free. Leave one tab connected for an hour with
  nothing else syncing and read the namespace's request metrics, which the same page says count
  messages one for one, the twenty-to-one being applied only on the bill: **about 81 says they
  are counted, about 1 — the upgrade alone — says they are not.** Step 7's alarm is still not
  built, and a tab is the first client that spends on the metered line by sitting still.
- **The access token in Workers Logs.** Invocation logs redact a request header by name —
  `cookie`, or one containing `auth`, `key`, `secret`, `token` or `jwt` — and
  `sec-websocket-protocol` is none of them, so a browser's socket upgrade should show its
  `bearer.<access>` in the clear where a desktop's `authorization` reads `REDACTED`. **Open one
  socket from the web app and read that invocation's headers.** If it is there, the choices are to
  accept it — a day-long token in the account's own three-day log — or to set
  `observability.logs.invocation_logs` to `false`, which costs every route its invocation log.
  **Chosen on 2026-10-04: accepted.** Nothing is changed, and the read above is now only a
  confirmation of what is being accepted.
- ~~**A removed device's socket.** The local run found that a rotation closes no socket: the
  removed device keeps its own, its panel reads the old group, and it learns at its next round
  trip — its own write, a *Sync now*, or the next push by anybody left. If that is wanted
  sooner it is a change to `group.ts`'s `roster` — close the departed devices' sockets — and a
  deploy of its own.~~ **Written, in step 6.3b — the ninth half, at the top of this page — and
  waiting on that deploy.**
- **A pre-flight's cache, and a pull's lack of one.** A browser files a pre-flight under the whole
  URL, so `/pull?since=…` is asked about again whenever the cursor has moved. Count the `OPTIONS`
  in the page's network panel across a few edits: one in front of most pulls is the design, and
  one in front of every push would mean `Access-Control-Max-Age` is not being honoured.

---

## Known limitations, written down rather than discovered

- **A group's whole log goes through the isolate's memory, on three routes.** `pull` reads every
  row past the cursor and serialises them into one answer; `ack`, whenever it moves a cursor,
  runs `compactNow`, which reads every row with its `sealed`; and a push refused for the quota
  does the same before it refuses. Measured locally, request by request with the heap collected
  between them ([light-app.md](light-app.md) §10.5): **a pull costs the isolate's JS heap
  twice the log** — 18 MB for a 9 MB log, 89 MB for a 45 MB one, a 50 000-row import — **and
  a compaction once**, 9 and 45 MB; the importing device's own pull, which reads the rows it
  just pushed in order to drop them, costs the log once as well. A push costs nothing that
  lasts. Local workerd enforces no memory limit; production allows an isolate 128 MB, shared
  by every group it hosts, so by these figures a pull meets it at a log of about 64 MB and a
  compaction near the quota. **No deployed relay has been asked for a log that size**, so what happens there — to
  the request, the group's socket and the isolate's other groups — is not known. The quota
  (128 MiB of sealed text a group) bounds the log, not what reading it costs.
- **A claim founds a group of one**, so a device that has claimed can no longer *join* another
  group — `pairing::complete` refuses a differing group id. **Connect on the device you will pair
  *from*, or pair first.** The panel says so; this is the note for when somebody asks why.
  **Pairing in the other order stopped being a dead end on 2026-08-30** — a device that pairs
  first and never connects is now entitled through its group — and this bullet also said "there
  is no Leave or Disconnect in the UI", which **Leave group** ended the same day. It is no longer
  a *dead end*: a device that claimed into a group of one can leave it and then join the group it
  meant to. It is still a trap worth naming, because leaving is a press a reader has to know to
  look for and `complete`'s refusal does not name it.
- **The sealed pairing blob is unversioned and its layout changed twice.** Builds from either side
  of a layout change are mutually unreadable, in both directions, and both report "That pairing
  key is unreadable". **The window narrowed on 2026-08-30**: the current three-field layout is
  byte-identical to the one that shipped before `86a9b8e`, so what cannot pair with today's build
  is the one-day four-field build in between.
- **A paired group with no membership errors on every Sync now.** `/keys` authenticates against
  rows only `/claim` seeds, so an unclaimed group gets a 401 there before `entitlement::
  access_token` can answer `STALE_GROUP_AUTH`. One folded `error_log` row per grain. It follows
  from the design rather than being a defect, and it is written down here because the error is
  the reader's first sight of it.
- **A freshly paired device cannot remove anything for one sync.** It holds no
  `SUPPORTER_STATUS` until the group door has answered it once, so `commands::entitled` reads
  `false` and Remove says *"Connect a membership first"* even though the group has a membership.
  It self-heals on the first round trip.
- **No tier check exists.** Any pledge of any size entitles. The campaign filter is the gate that
  matters — a pledge to another creator does not entitle.
- **The OAuth `state` never returns to the app**, so it is unverifiable end to end. It is received
  and not checked.
- **Nothing sweeps expired `claim_codes`.** Rows for codes never redeemed accumulate; the cron does
  not touch that table.
- **Non-2xx, non-401 relay answers surface verbatim** — a claim against a lapsed membership shows
  "the relay answered 403 to /claim". Both 403 and 409 are states a reader can reach.
- ~~**`entitlement::clear` has no production caller**~~ — **it has two since 2026-08-30.**
  `client::check_keys` calls it beside `identity::leave_group` when `/keys` answers a higher epoch
  with no blob, because a removed device that kept its refresh secret would keep a *working
  credential for the group it was removed from*: the refresh door mints a token whose `grp` is
  that group and `/g/{group}/push` honours it, so the rotation would stop it reading anything new
  while it went on spending the group's requests. `pairing::leave_group_now` calls it for the same
  reason from the other side, on a device that left of its own accord. **`clear` and never
  `revoke`** on both paths, because nothing ended — the reader's pledge is untouched and this
  device simply left a group, so the panel draws *Not connected* rather than *Membership ended*.
  ⚠️ **The absent "Disconnect control" this bullet used to end on is not owed any more, and was
  never quite the right name for it.** Leaving takes the membership with it by design, so
  *Leave group* is the press; disconnecting a membership while *staying* in the group is a
  different thing nobody has asked for.
