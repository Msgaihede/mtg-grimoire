# `relay/` — the sync relay

A Cloudflare Worker with **one SQLite-backed Durable Object per pairing group**, plus a D1
database that says who is allowed to reach one. It holds a compacted log of sealed envelopes,
hands each device the ones it has not seen, and forgets the ones every device has acked once
they are older than thirty days.

**It is one hosted service now, not one deployment per reader, and that is the change everything
else in this file follows from.** The address is compiled into the app —
`entitlement::RELAY_BASE`, `https://mtg-grimoire-relay.denmark-east.workers.dev` — public in the
way every application's API base URL is public, and no longer a setting a reader types into
Settings. What a reader supplies instead is a **membership**: they connect Patreon once, paste a
claim code, and the app trades it for a pair of tokens.

**What is deployed at that address today is the whole entitlement Worker, key distribution
included.** Probed 2026-08-30, after that day's second deploy: `/claim` and `/token` answer
**405** to a GET (the route is there and wants POST), `/oauth/patreon/callback` **400**,
`/g/{group}/pull` **401** from the bearer gate, `/g/{group}/push` and `/g/{group}/ack` **405**,
`/g/{group}/rotate` **401** to a POST, `/g/{group}/keys` **401** to a GET carrying a well-formed
bearer — and `/g/{group}/bogus` **404**, so a 404 here still means "no such route" and those 401s
are handlers refusing rather than a router shrugging.

⚠️ **This paragraph has now been wrong twice about the same host, in the same week.** It first
said nothing was deployed at all, and that was repeated into two `CLAUDE.md` files before anybody
asked; corrected, it then said `/rotate` and `/keys` were "this change's two routes" still
missing, and survived a few hours past the deploy that shipped them. **Step 0 of the runbook is
those `curl`s written down**, and it is the only sentence in any of these files that cannot rot.

**The device roll is deployed as well** — `group_devices`, the cap, `/claim` moving a binding,
`keepOnly` — **and it adds no route, so no path probe can see it.** The tell is a body:
`POST /token {"refresh":"x"}` with **no `device`** answers **400 `that is not a device id`** on the
live Worker (2026-09-28), and **401** once `"device":"deadbeef"` is added. ⚠️ **This paragraph said
it was not deployed until that day**, on a `{"group":…,"auth":…}` probe the group door refuses as
`malformed token request` — its `auth` was not 64 hex — before it reads `device` at all. **The
pairing rendezvous is live too**: `GET /p/{32 hex}/offer` answers a JSON `nothing there`, not the
router's plain-text `not found`. **The last deploy was 2026-10-01 at 22:09 UTC, from
`claude/relay-rate-limits` at `7f6d6f50`**, and carried the rate limits below; the one before it,
the same day from `main` at `2b845048`, carried issue #548's `dev` claim — `token.ts` and
`claim.ts`, no migration, and nothing a probe without a credential can see. Deploying this tree is `npx wrangler deploy` from here, and it
is the last of the steps under **Deploying** below rather than the whole of them.

**Issue #546's half is deployed, and it adds no public route either** — the push admission,
`/keys?epoch=` and `removalStep`, `/rotate`'s two-epoch step, the internal `/roster`, the hourly
reconciliation and the group door's `membership_ended`. Its tell is a query parameter:
`/g/{group}/keys?device=…&epoch=x` carrying any well-formed bearer answers **400 `that is not an
epoch`** from this tree, which checks the epoch's shape before the credential's value, and **401**
from a Worker that ignores the parameter. **Probed 2026-10-01: 400.** ⚠️ **This paragraph said
"what is not deployed" until that day.** The deploy went out on 2026-09-28 at 19:57 UTC — nine
minutes after the half merged — and nobody recorded it; the probe had been read off `handleKeys`
and never run. A device meets the same fact from inside: its own `/keys` 200 carries
`removalStep: 2`.

**What is written and not deployed is the browser's half** (light app phase 6, issue #761): CORS
for the web app at `https://mtg-grimoire.app`, the `APP_ORIGINS` var that lists it, the socket's
bearer as a sub-protocol, the socket's own origin check, and the `ping`/`pong` auto-response. It
adds no route and no migration. Its tell is a pre-flight: `OPTIONS /token` carrying `Origin:
https://mtg-grimoire.app` and `Access-Control-Request-Method: POST` answers **204** from this tree
and **405** from a Worker without it. **Probed 2026-10-04 at 15:49 UTC: 405**, with the same 405
for `Origin: https://example.com` — the control, and the answer both origins get from a Worker
that has never heard of either. The runbook's step 0 has the three pairs. ⚠️ **The web app must be
deployed after this and never before**: a page asking a relay that answers no pre-flight fails
every request, and what its engine sees is a network error with no status to act on.

## What it cannot do

**It cannot read anything it stores.** The group key is minted during pairing and lives only on
the paired devices; the relay sees a `sealed` string, an epoch, a device id and a hybrid logical
clock. It orders and compacts by the clock and never looks inside. That is still true, and it is
still the reason none of this needs an account in the ordinary sense.

**It cannot un-tell a removed device what it already knows.** That is §7.6's problem, not this
file's.

## The auth gate, and why it stands in the Worker

**This file used to say there was no authentication on the endpoints and that the absence was
deliberate.** The argument was that the relay can decrypt nothing it stores, so the worst a
stranger who guessed a group id could do is read bytes they cannot open. That argument has not
stopped being true — it is simply no longer the whole question. Against a relay each reader
deployed themselves, a stranger spent the reader's own free tier. Against a hosted one they spend
**somebody else's bill**, and the bill is what now has to be guarded.

So every `/g/{group}/…` request carries `Authorization: Bearer <access>`, and `src/index.ts`
verifies it **before the Durable Object hop**. The position is the point, not the check:

- **A request that reaches a Durable Object bills a Durable Object request whether it is honoured
  or refused**, and that is the line that meters (§8 below). Verifying an HMAC in the Worker costs
  microseconds, touches no storage at all, and refuses junk for the price of a Worker invocation
  alone.
- The gate compares the signature, the expiry, **and `payload.grp` against the path segment**.
  That last comparison is not redundant with the signature: a validly signed token for the
  attacker's *own* group is exactly what an attacker has, and without the comparison it would open
  every group on the relay.

`access` is `base64url(payload) "." base64url(HMAC-SHA256(payload, RELAY_HMAC_KEY))` over
`{sub, grp, exp, dev}`, with a **24-hour** TTL (`TOKEN_TTL_MS`). `dev` is the device the door
admitted, added 2026-10-01 for the share Worker's removed-device check; nothing in the relay
reads it, and a token without one (an older relay's) still verifies. The app trades its long-lived
`refresh` secret for a new one when fewer than six hours remain. That split is what makes lapse
work: deleting `refresh_secret` is instantaneous, and an already-issued `access` dies of old age
within a day.

**One route takes the same token from a second place, and only that one.** A browser's
`WebSocket` cannot set a header, so `GET /g/{group}/ws` with no `Authorization: Bearer` reads the
`bearer.<access>` entry of `Sec-WebSocket-Protocol` instead — the same `verify`, the same `grp`
comparison, the same 401. The header wins when both are there, which is every released desktop.
`push`, `pull` and `ack` never look at the sub-protocol: a `fetch` can set a header, and a second
place to find a credential is a second way in. See "The browser" below and `src/ticket.ts`.

**The four claim-layer routes are deliberately not behind the gate, and each is guarded by
something else.** `/oauth/patreon/callback` by the authorization code Patreon redirects with,
`/claim` by a single-use code that expires in ten minutes, `/token` by **the refresh secret or the
group auth** it is presenting, and `/webhook/patreon` by its HMAC. A bearer token could not guard
any of them — three of the four exist precisely because the caller has no token yet. **Two `/g/…`
routes stand outside the gate too since 2026-08-30**, for a different reason and with credentials
of their own; see "The endpoints".

## The entitlement table

`relay/schema.sql`, whose first table this is. The Patreon adapter is the only Patreon-shaped code
in the design; everything downstream reads `status` and never asks who vouched, so **adding Paddle
later is one adapter file, one webhook route, and rows with a different `source`.**

```
entitlements(
  subject         TEXT PRIMARY KEY,   -- minted here, and NOT the Patreon user id
  source          TEXT NOT NULL,      -- 'patreon' today; 'paddle' later
  external_id     TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('active','grace','dead')),
  grace_until     INTEGER CHECK (grace_until IS NULL OR grace_until > 0),
  group_id        TEXT,               -- bound on first claim, trust-on-first-use
  refresh_secret  TEXT,               -- NULL once revoked; this is what revocation clears
  patreon_refresh TEXT,               -- the reader's own token, for the reconciliation
  created_at      INTEGER NOT NULL,
  checked_at      INTEGER NOT NULL    -- stamped by every /token, which is why nothing queues by it
)
-- and, each an ALTER at the end of schema.sql:
--   group_epoch, group_auth  -- the group's current epoch and auth           (2026-08-30)
--   refresh_device           -- the device /claim handed refresh_secret to   (2026-09-26)
--   reconciled_at            -- when the cron last TRIED this subject;
--                               NULL is never, and the front of the queue    (2026-09-28)
```

**Every `/claim` mints a fresh `refresh_secret` and records the claiming device in
`refresh_device`** (an `ALTER` at the end of `schema.sql`). The secret opens `/token`'s refresh
door, so it must not outlive its device's place in the group: an accepted rotation whose manifest
omits `refresh_device` sets both to NULL, and a lost device that pressed Connect stops minting
tokens for the group that removed it. A row with a secret and no recorded device was claimed
before the column existed; the next accepted rotation retires it. **The secret opens no
`/rotate`** — that route takes the group's current auth and nothing else.

**`subject` is minted by the relay and is not the Patreon id.** The Patreon id lives in exactly
one column of one table; the token, the group binding and every log line name the subject
instead. A reader who moves between two sources keeps their subject and their group.

**Two unique indexes, and each closes a different hole:**

| Index | What it stops |
| --- | --- |
| `entitlements_external (source, external_id)` | a second row for one Patreon user, so a webhook naming them finds the subject in one lookup and never has to choose |
| `entitlements_group (group_id) WHERE group_id IS NOT NULL` | two subjects bound to one group, which is a shared subscription wearing two names — both could mint tokens for it |

The partial predicate on the second is load-bearing: a plain unique index would allow exactly one
unbound row, and every reader is unbound between connecting and their first claim.

**`status` is CHECKed and `source` deliberately is not.** The status set is closed here — it
mirrors `Status` in `entitlement.ts`, which `decide` exhausts with a `switch`, so a fourth value
could only arrive as a typo, and a subject holding one would be neither serving nor dead with
nothing to say so. `source` is open because a second value is expected and SQLite cannot add or
drop a CHECK with `ALTER TABLE`; closing it would mean rebuilding the table on the day Paddle
arrives, which is the friction the subject indirection exists to avoid.

`claim_codes` is the short-lived code the landing page shows. **It enforces neither of its two
rules** — there is no `used` column and no sweep — so both live at the call site: the expiry is
`expires_at > now`, and single-use means the `DELETE` happens in the same transaction as the read.
Read-then-delete would let two racing requests both claim.

**Two more tables landed on 2026-08-30**, and `entitlements` gained `group_epoch` and `group_auth`
beside them:

| Table | Key | Answers |
| --- | --- | --- |
| `group_keys` | `(group_id, epoch)` | the key history `/keys` serves from, and the manifest whose key set **is** the roster. Pruned to the last `EPOCH_HISTORY` (8) **epochs, not rows**, by the same batch that writes a new one — `epoch <= newest - 8` goes. A join steps the epoch by one and a removal by two, so a run of joins keeps eight rows and a run of removals four: a device dark across three removals still reaches `/keys` with the auth it holds, and across four is refused the 401. At one step per rotation it survived seven rotations of any kind. |
| `group_devices` | `(group_id, device_id)` | the device roll, so `/token` and `/claim` can cap a membership at `MAX_GROUP_DEVICES`. `first_seen`, `last_seen`, and nothing else. |

**One table answers both caps the reader asked for** — five per account and five per group —
because a subject is bound to exactly one group and a re-claim *moves* that binding rather than
adding a second, so there is no arrangement in which the two sets differ.

**`group_devices` gets no secondary index, and that is a decision rather than an omission.**
SQLite builds one for a rowid table's `PRIMARY KEY`, `group_id` is its leading column, and
`(group_id, device_id)` *covers* every read here — each is `WHERE group_id = ?` or that plus an
equality on `device_id`. A `(group_id)` index would serve nothing and cost a second b-tree write
on every `/token`, the hottest route this Worker has.

**It holds no name, on purpose.** What a device is called is `device_names`, is synced between the
devices under the group key, and the relay never sees it.

**A slot frees two ways and neither is a sweep.** `/rotate`'s `keepOnly` deletes the rows its
manifest omits, so a removal and a departure each free one; and a row unseen for `DEVICE_TTL_MS`
— ninety days — is not counted and is pruned when the count is taken, because a wiped data folder
mints a *new* device id and would otherwise cost the reader a slot for ever.

## The flows

### Connecting (§6.1)

1. The reader presses **Connect Patreon**. The app's `sync_patreon_begin` mints a `state`, stores
   it, and answers the authorize URL; TypeScript opens it with the `opener` plugin.
2. Patreon authorizes with scopes **`identity` and `identity.memberships`** — `identity` alone
   answers who the reader is and nothing about what they pledge, so the flow would complete and
   then refuse them — and redirects to `GET {RELAY_BASE}/oauth/patreon/callback`.
3. The Worker exchanges the code, reads the membership whose campaign is `PATREON_CAMPAIGN_ID`,
   `decide`s a status, upserts the row, mints a claim code and renders **one page**: *"You are
   connected. Paste this into MTG Grimoire within ten minutes: `XXXX-XXXX-XXXX`."*
4. The reader pastes it. `sync_patreon_claim(code)` calls `POST /claim {code, group}`.

**The `state` parameter is received and checked by nobody, and that is stated rather than left as
an absence.** The app mints it and opens the authorize URL, but the redirect lands *here* rather
than back in the app, so the app never sees it again and nothing carries it to `/claim`; the relay
cannot check it either, holding no record of a flow it did not start. What binds the page to the
reader instead is that the code is shown only to the browser session that completed the consent,
is single-use, and expires in ten minutes. The app stores its `state` in `sync_state.patreon_state`
so that the day either side does carry it, the comparison is a one-line change rather than a
protocol one.

**The redirect lands on the relay and never on a loopback listener in the app.** The
`client_secret` can only live server-side, so the exchange happens here whatever the app does; a
listener would buy a listener and nothing else. This way the app runs no HTTP server, handles no
redirect and needs no CSP change.

**The claim code is twelve Crockford base32 characters**, reusing `sync_pair::invite`'s alphabet
rather than inventing a second one — it omits `I`, `L`, `O` and `U` and folds the confusions a
person makes copying between two screens, which is exactly what this code is for. **There is no
checksum**, which the spec sketched and the implementation does not carry: `normaliseCode` folds
Crockford's three substitutions and the lookup itself is the check, so a mistyped code finds no
row and is refused in the same sentence as an expired one. Sixty bits over a ten-minute window,
single-use.

The mint is `DELETE … RETURNING` in **one** statement, and that is not tidiness: D1 has no
interactive transaction, so a read followed by a delete is two round trips with a window between
them, and two requests racing that window would both see the code and both claim.

**`/claim` carries the group id and that is not optional.** The token payload is `{sub, grp, exp, dev}`
and the gate compares `grp` against the path segment, but `/claim` carries no `Authorization`
header — the device has no token yet, which is the point of the call — so the body is the only
channel there is. A claim without it mints a token whose `grp` matches nothing, and the reader
connects Patreon successfully and then finds every push, pull and ack 401ing for ever. A device in
no group makes a group of one first; that is the app's `sync_engine::commands::ensure_group`, not
this side.

**`expires` and `since` are unix SECONDS on the wire.** This side counts in milliseconds
throughout (`TOKEN_TTL_MS`, `nowMs`, `GRACE_MS`) and the app counts in seconds (`unixepoch()`), so
the boundary picks one and says so. A millisecond value reaching the app makes `expires - now`
about 1.8e12, forever past the refresh margin, so the token is never refreshed and every sync
request 401s a day later on the *sync* route, where nothing re-mints: sync dies silently and
permanently. The relay converts; the app holds a magnitude guard so the unit cannot regress in
silence.

### Lapse (§7)

`members:pledge:delete`, or a `members:update` that drops the reader below the tier, sets
`status = 'dead'`, clears `refresh_secret`, and calls the group's Durable Object to drop its log.

**Deleting the relay log destroys no reader data.** Every device holds the whole collection in its
own SQLite; the log is a transport buffer with a thirty-day tail, and resubscribing resumes
without re-pairing because baseline emission already knows how to re-found a group from a device's
own state. The app's Settings copy says so, and it must, or a lapse reads as data loss.

**A declined card is not a cancellation.** `declined_patron` is a failed card that Patreon
retries, so it sets `status = 'grace'` with `grace_until = now + 7 days` and still mints tokens.
`former_patron` and `pledge:delete` are `dead` at once.

**The webhook is primary and the cron is the backstop.** Webhooks are verified against
`X-Patreon-Signature`, the **hex digest of the raw body, HMAC signed with MD5** — Patreon's
choice, sound for authentication, and `md5.ts` carries the comment saying so because the next
reader will want to "fix" it to SHA-256 and break every webhook. Workers' Web Crypto offers MD5 as
a documented non-standard digest but **not** as an HMAC hash, so the construction is by hand over
two raw digests and is tested against RFC 2202's published vectors. **A webhook that fails
verification is refused and logged, never processed**: an unverified `pledge:delete` deletes a
reader's log, which is the one bug in this design that would destroy something.

The hourly cron reconciles rows that webhooks missed and closes expired grace windows. It refreshes
**each subject's own stored Patreon token** rather than reading the campaign through a creator
token, which is why there are three secrets below and not the spec's four. A row with no stored
token still gets its window settled, and an identity document the code cannot parse **throws
rather than deciding** — `decide(null, …)` is `dead`, right for a reader Patreon says has no
membership and catastrophic for one shape change on Patreon's side, which would otherwise become a
mass revocation in a job nobody is watching.

**Patreon API v1 retires 2026-10-07. This uses v2 exclusively.**

**The group door names a lapse, and it is the only 401 on either door that carries a code.** When
`/token {group, auth, device}` presents the group's **current** auth and the membership has settled
`dead`, the answer is **401 `{"error": "unauthorized", "code": "membership_ended"}`** — the
revocation and the Durable Object drop still run on the way. Until issue #546 that 401 was bare,
which the app reads as a stale auth (`STALE_GROUP_AUTH`), because a rotation it has not caught up
with is refused in the same words; so a device that never pressed Connect, whose only door this
is, re-checked `/keys`, found itself still in the group, and went on saying *Supporting since …*
over a pledge that had ended. **It is safe to say because only the current auth reaches it**, and
only a device holding the group key can derive that. A stale or wrong auth, the refresh door and
the unreachable no-row case stay a bare 401 — a removed device must learn nothing about the group
it left. `sync_engine::entitlement` matches the code, never the sentence, and revokes on it.

### The reconciliation: an hourly pass on a budget

**A pass is a budget, not a walk of the table.** Each invocation (`0 * * * *`) selects at most
`RECONCILE_BUDGET` — 20 — live rows that are due, least recently reconciled first:

```sql
WHERE status <> 'dead' AND (reconciled_at IS NULL OR reconciled_at < now - RECONCILE_INTERVAL_MS)
ORDER BY reconciled_at, subject
LIMIT 20
```

SQLite sorts NULL below every value, so a subject never asked goes first. **One `UPDATE` stamps
every selected row before any is attempted**: a row whose attempt throws — a revoked Patreon grant
throws every time — goes to the back of the queue instead of heading it for ever, and so does one
whose attempt outlives the invocation. If the stamp itself fails nothing is attempted, because an
attempt that could not write back would lose the refresh token Patreon had just rotated. A row
with no Patreon token counts against the budget like any other. `RECONCILE_INTERVAL_MS` is twenty
hours, so the hourly cron asks about a subject about once a day and not twenty-four times.

⚠️ **The pass this replaced walked the table by `subject` from the beginning, daily at `0 3`,** so
it reached the same first subjects every day — and by the arithmetic below every fetch after about
the twenty-fifth row threw, each caught, logged and forgotten. A cancellation whose webhook was
missed, behind those rows, synced for as long as the relay ran.

**It queues by `reconciled_at` and never by `checked_at`**, which looks like the same fact and is
not: `serveOrRevoke` stamps `checked_at` on every `/token`, so the subjects actually syncing — the
only ones a missed cancellation costs anything — would be for ever the most recently checked and
never come up. `reconciled_at` is written by this pass alone.

**Capacity** is 20 × 24 = 480 attempts a day, which at one turn every ~21 hours (the twenty-hour
rest plus the wait for the next hour) is about 420 live memberships. Past that the backstop slows
rather than stops — each subject every `rows / 480` days — and the webhook stays the primary.

⚠️ **The budget is the free plan's limits divided by what a row spends, and the limits are
unverified.** They are search summaries of Cloudflare's pages, which could not be read from where
this was written: **50 external subrequests per invocation**, against two per row that holds a
token (the refresh and the identity read) — 40 at this budget; and **50 D1 queries per
invocation**, against one `SELECT`, one stamp and at most two `UPDATE`s a row — 42, and 43 with the
rendezvous sweep `scheduled` runs after it. The old pass's ~25 subjects a day is derived from the
same reported figure, not measured against the host.

**`entitlements_reconcile`** is the partial index the query reads, `(reconciled_at, subject) WHERE
status <> 'dead'` — dead rows are the table's only growing half and the pass never selects one.
Measured on SQLite 3.45.1 (Python's `sqlite3`, **not D1**) at 20 000 rows: without it, a full scan
and a temp-B-tree sort, about 220 000 VM steps with a backlog; with it, an index walk that stops at
the `LIMIT`. `/token`'s `SET checked_at` writes neither indexed column and pays nothing for it.

## The endpoints

**The `/g/…` routes a Durable Object answers are the ones behind the bearer gate** — one object
per group, addressed by `idFromName(group)`.

| Request | Body | Answer |
| --- | --- | --- |
| `POST /g/{group}/push` | one `Envelope` | `200 {"cursor": <seq>}` — the stored row's seq; the refusals are below |
| `GET /g/{group}/pull?since={cursor}&device={id}` | — | `200 {"envelopes": [...], "cursor": <head>}` — and the device counts as heard, at most once a day |
| `POST /g/{group}/ack` | `{"device": id, "cursor": n}` | `204` — and compaction runs; a departed device's ack is answered and not stored |
| `GET /g/{group}/ws?device={id}` | — | `101` — a hibernatable socket; see the last section. The bearer may be a sub-protocol, and a foreign `Origin` is a `403` — "The browser" below |

**A push is admitted in the Worker, after the gate and before the Durable Object hop**, because a
request that reaches the object bills whether it is stored or refused, and none of these needs the
object's state to be refused. In the order a push meets them, every refusal but the two 400s is
`{error, code}` and clients match on `code`:

| # | Refused when | Answer |
| --- | --- | --- |
| 1 | the declared `Content-Length` is over `MAX_PUSH_BODY_CHARS` (1 504 096 — the sealed cap plus 4 KiB) — **before a byte is read**; a missing or non-numeric header decides nothing | `413 too_large` |
| 2 | the body's text is longer than that | `413 too_large` |
| 3 | the body is not JSON, or not an envelope | `400 unreadable body` / `400 malformed envelope`, no code — the object's words, unchanged |
| 4 | `sealed` is over `MAX_SEALED_CHARS` (1 500 000, `log.ts`) | `413 too_large` |
| 5 | the envelope's epoch is below the group's — its newest `group_keys` row, one read on `group_keys_by_group` | `409 stale_epoch` |
| 6 | … or above it | `422 epoch_ahead` |
| 7 | `hlcMs` is more than `MAX_CLOCK_AHEAD_MS` (a day) past the relay's clock; exactly a day is admitted | `422 clock_ahead` |

Then the object: an envelope naming another group is the `409 group mismatch` below, and a log that
this push would take past `MAX_GROUP_LOG_CHARS` (128 MiB of `sealed`) is **`507 quota`** — exactly
at the cap is stored. The quota is the one refusal on the far side of the hop, because the log's
size is the object's to know. **The object compacts before it refuses**: a full group refuses every
push, so no device's head moves and no ack would ever run a compaction again — without that pass,
rows aged past the thirty-day tail behind every ack would never be deleted and the group would stay
full for good. The full scan is paid only by a push about to be refused.

- **The sealed cap is the Durable Object's 2 MB row**, less headroom for the other six columns;
  `sealed` is base64url, one byte a character. It refuses no batch the app builds: a 512 KiB
  plaintext batch seals to 699 104 characters, about 47% of it, and the fattest batch ever measured
  sealed to 186 188. What meets it is one op that is alone larger than a batch — a note pasted in
  the megabytes — and `wire::oversized` asks the app the same question before it sends one.
- **`stale_epoch` stops a removed device writing under the key it was removed from** for the day
  its token outlives the rotation, and tells a device merely behind one to catch up. **`epoch_ahead`
  is the one that froze whole groups**: anyone holding a token could push `{epoch: 1e12}`, and
  every peer that pulled it held its cursor waiting for keys to an epoch that would never exist. A
  group with no key rows — claimed before `group_keys`, never seeded or rotated since — skips both
  rather than refusing every push to the group. **The epoch is read off `group_keys` and not off
  `entitlements.group_epoch`**: `recordRotation`'s insert is the rotation's acceptance and the
  mirror follows in a second statement, so a mirror that failed to follow would otherwise refuse
  every push at the epoch the group has really reached.
- **A day of clock is what an honest machine can be wrong by**: one that dual-boots Windows, which
  keeps the hardware clock in local time, and Linux, which keeps it in UTC, is off by its time
  zone's offset — up to fourteen hours. A clock a day fast wins every last-writer-wins comparison
  and drags every peer's hybrid logical clock forward with it, for good.
- **The quota is a fence against a runaway, not a budget for a reader.** Durable Object storage is
  5 GB account-wide on the free plan, so without it one client pushing in a loop — buggy, or
  hostile with a valid token — could spend it all; with it, that takes some forty groups at the
  cap. A 50 000-row import is about 250 batches, ~22 MB at the measured ~90 KB average and ~46 MB at
  the fattest op, and the thirty-day tail keeps even a fully acked one for a month. The refusal
  clears on its own as compaction runs: it is *not now*, not *never*. The object keeps the size as
  a running total in `log_size` rather than a `sum()` per push — Durable Object SQL bills rows read,
  so the check would cost most exactly when the log is nearest the cap — and not `databaseSize`,
  which is a high-water mark that compaction never lowers. Every compaction recomputes it exactly.

**Two more `/g/…` routes stand *ahead* of the gate, and the placement is the point rather than an
exemption.** ⚠️ **This section said "every one of them is behind the bearer gate" until
2026-08-30**, when these landed.

| Request | Body | Guarded by | Answer |
| --- | --- | --- | --- |
| `POST /g/{group}/rotate` | `{epoch, auth, keys}` | the group's current auth | `200 {epoch}` for one past the group's newest (a join) or two past it (a removal or a departure); `409` behind or equal; `422` further ahead |
| `GET /g/{group}/keys?device={id}[&epoch={n}]` | — | any auth the group has used within `EPOCH_HISTORY` epochs | `200 {epoch, blob, devices, removalStep: 2}` — the newest manifest, or with `epoch` the one stored at exactly `n`; `404 no_such_epoch` for none there |

A device that has just been rotated away from **cannot mint a token** — the auth it would present
to `/token`'s group door is stale by definition — so a `/keys` behind the gate would refuse
exactly the caller it exists to serve, and a removed device would sit for ever in a group it is no
longer in. **Every refusal either route makes is decided in the Worker, out of D1, and none reaches
the Durable Object** — which is what makes standing outside affordable: the gate is in front of
the DO because a request that reaches one bills a Durable Object request whether it is honoured or
refused. `/keys` never reaches it at all. `/rotate` reaches it **exactly once, after D1 has
accepted the rotation**, to post the roster below — and a caller that gets that far holds the
group's current auth, which mints a bearer token at `/token`'s group door and opens the gated
routes anyway, so it can spend nothing here it could not already spend there. **Both are rate
limited since 2026-10-01**, with `/claim`, `/token` and the pairing rendezvous: what standing
outside the gate costs is a D1 read per request from anyone, and `src/ratelimit.ts` refuses a
caller past its limit ahead of that read — per client address, through three `ratelimits`
bindings in `wrangler.jsonc`, as a **429 with `code: "rate_limited"`** and never a 401. It fails
open, and it spares the read rather than the request. ⚠️ **It bounds a flood and does not meter a
trickle**: measured against the live Worker, sixteen requests against a limit of ten drew no
refusal and four hundred in eight seconds drew 347. The runbook's step 8 has the limits, that
measurement, the burst that says whether a deployed Worker has them, and what a limit inside the
Worker cannot do.

**The epoch must be one or two past the group's newest, and nothing else.** A join plans its own
epoch plus one and a removal or a departure plus two (`REMOVAL_STEP`), and the auth a device
presents is current only if its own epoch is the relay's, so no shipped client sends anything
further. **The step is the authenticated join/removal marker**: the rotator binds the epoch into
every rewrapped blob's AAD, so a relay that relabelled a removal as a join would be handing out
blobs that do not open, and a device adopting a `+2` forgets every superseded key whatever the
manifest's `devices` say. Both bounds sit in one `INSERT … SELECT … WHERE ? > max AND ? <= max + 2`,
because D1 has no interactive transaction. "Strictly higher" let a caller holding a credential move
the group to `1e9` with a manifest of its choosing, which every device then reads its membership
off. A behind or equal epoch is still the `409` a device can lose a race to; one further ahead is
**`422 that rotation steps further ahead than any rotation may`**, since no client produces it.

**The app steps a removal by two only after a `/keys` answer has carried `removalStep: 2`**, and
latches that for good. A relay without this change answers a `+2` with the 422 it gives a skip, so
a device that stepped by two unasked would have every removal it published refused; latched, it
goes on sending `+1` to an old relay, which accepts it, and nothing breaks in either deploy order.
`removalStep` is `REMOVAL_STEP` itself, the same constant `/rotate`'s bound is built from, so what
the relay advertises and what it accepts cannot disagree.

**`/keys?epoch=n` is for the device that skipped one.** Standing on *N* and answered *N+2*, it has
never held *N+1*'s key — so it asks for that epoch by name, from rows `group_keys` was already
keeping. The checks run in this order: the credential's shape (`401`), the device (`400 that is not
a device id`), the epoch — digits only and a safe integer, so `""`, `-1`, `1.0`, `1e0`, `0x1`, `+1`,
`" 1"` and `9007199254740993` are all **`400 that is not an epoch`**, where `Number` would have
quietly read most of them as some other epoch — then the auth (`401`, and an unknown group is still
a 401 rather than a 404), then the lookup. **A miss is `404 {"code": "no_such_epoch"}`, and it is
an answer rather than a failure**: never written, stepped over by a removal, pruned, or not reached
yet are one answer because a caller can act on none of them differently. ⚠️ **A `blob: null` in
answer to `epoch` says "you held no key then" and is never the removal notice**, which is read off
the newest manifest alone. A relay without this change ignores `epoch` and answers the newest
manifest, which the app detects by the answered epoch not being the one it asked for.

`/rotate`'s manifest is capped at `MAX_GROUP_DEVICES` (**64 until 2026-08-30**, which was a bound
on what D1 would store rather than a policy) and 4 KB per blob. **After `recordRotation` succeeds,
and never before it** — a refused rotation must free nothing — it retires the refresh secret if the
manifest omits its holder, calls `keepOnly` so the rotation frees the `group_devices` rows its
manifest omits, and then, last and best effort, tells the log its roster.

`{group}` is constrained to `[A-Za-z0-9_-]{1,128}`, from **one** shared constant that `claim.ts`
applies to the group id in a `/claim` body as well. Without the constraint, `%41` and `A` would
name two different Durable Objects that a reader would read as one group, and there is no later
point at which that becomes visible; without sharing it, a claim could bind a group id the router
can never carry — a claim that succeeds and a sync that can never work.

The entitlement layer's four routes are fixed paths, matched ahead of that pattern:

| Request | Guarded by | Answer |
| --- | --- | --- |
| `GET /oauth/patreon/callback?code=…` | the authorization code | an HTML page carrying the claim code |
| `POST /claim {code, group, epoch, auth, device}` | the one-time code, ten minutes | `{access, refresh, expires, status, since}`; `409` if **another subject** holds that group id |
| `POST /token {refresh, device}` | the refresh secret | the same five fields, or `401` once revoked |
| `POST /token {group, auth, device}` | `crypto::relay_auth` over the group key | four fields — **never a refresh secret**; `401` bare for an auth that is not current, `401 membership_ended` for one that is, over a membership that has ended |
| `POST /webhook/patreon` | `X-Patreon-Signature` (HMAC-MD5) | `204`, or `401` unverified |

**Four routes, and `/token` is one of them wearing two bodies.** The shape is decided on the
*presence* of `refresh`, not its validity, so a body carrying both fields cannot be steered onto
the weaker door by sending a `refresh` the caller knows is malformed.

⚠️ **`device` is required on all three of those bodies since 2026-08-30, and the refresh door is
the one it would have been easiest to leave off** — the device that pressed Connect never reaches
the group door, so a cap that counted only the group door would never count the one device that is
certainly signed in. Required and not used-if-present, because a field the relay merely reads when
it is there is a cap any caller opts out of by omitting it. A body without one is **400 `that is
not a device id`**, before any lookup.

⚠️ **`/claim`'s 409 changed meaning rather than going away.** A subject that already holds a
*different* group is now **rebound**: bind the new group, `seedGroup` it, then release the old one
(`group_keys` rows, `forgetGroup`'s `group_devices` rows, and the Durable Object's log last). The
bind happens first and the teardown after, because the surviving 409 — another **subject** holding
this group id — is caught from the unique violation and so cannot be predicted, and a
teardown-first ordering would destroy a working group on the way to refusing the press that asked
for it. What the rebind costs is stated in the app before the press: the devices left in the old
group lose their log and their manifest.

**A push whose envelope names a different group is refused with 409.** A Durable Object is
addressed by id, and the id is derived from the same path segment — so a body that disagrees has
reached an object that is not its own. That is either a client bug worth seeing or an attempt to
write into somebody else's log.

**The cursor a pull hands back is the head of the whole log, not of the returned slice.** The
slice has the puller's own rows filtered out of it, and a cursor taken from the slice would sit
below them, so the device would re-ask for its own rows on every pull for as long as they survived
compaction.

### Who the log waits for

**Compaction deletes a row only when every device has acked it and it is older than thirty days**,
and "every device" is the one question in the relay where a wrong answer loses rows. It starts as
every device the object has heard from in either direction — its `acks` and its log's senders — and
**two kinds are taken off it**, both of which used to hold the floor for good:

- **A device a rotation's manifest omitted.** `rotate.ts`'s `sendRoster` posts `{epoch, devices}` —
  the adopted manifest's key set — to the internal `POST /g/{group}/roster`. Every device the object
  knows that the list omits is marked in `departed` and its ack deleted; every device it names loses
  any mark, which is how one that left and was paired back in holds the floor again; then a
  compaction runs. **A roster is applied only if its epoch is strictly newer than the last one
  applied** (`roster_epoch`, `log.isNewerRoster`): each is sent from inside the `/rotate` request that
  recorded it, so two rotations accepted back to back post two rosters that nothing else orders.
  The post is best effort — a failure is logged and the rotation's 200 stands, because a non-2xx
  there would tell the rotator its rotation was refused. The next accepted rotation's roster still
  omits the departed device; until one arrives, the TTL below is the backstop.
- **A device not heard from for `ACK_TTL_MS`** — ninety days, `groupauth.ts`'s `DEVICE_TTL_MS` by
  import, for the same reinstall: a wiped data folder mints a new id, so the old one is named by no
  manifest and no roster ever departs it. "Heard" is the later of its ack's `heard_at` and its
  newest row's `stored_at`, so a device that only pushes is as alive as one that only pulls; exactly
  ninety days still counts. **Every ack sets `heard_at`, and a pull refreshes it at most once a day**
  (`HEARD_REFRESH_MS`), because a device holding its cursor — a newer sender's op it cannot read
  yet — pulls on every trip and never acks, and must not age out of the floor while it waits.

When nobody is left, the floor is zero and everything is kept: the devices still in the group are
then ones the object has never heard from, about to replay from zero. **An ack from a departed
device answers `204` and is not stored** — a removed device's token outlives its removal by up to a
day, and storing its ack would enrol it back on the floor with a cursor it will never advance. Only
a roster naming it again un-departs it, and `drop`, which empties the log, the acks and the size,
keeps `departed`: a membership ending un-pairs nobody.

**Three gaps, stated rather than discovered:**

- **A device away more than ninety days comes back to a log compacted past its cursor, and nothing
  on the wire tells it.** The rows in between are gone. A fix would be the relay answering the
  highest seq it has compacted, so the client knows to ask for a baseline; not built.
- **A removed device the object never heard from before its removal is not marked departed** —
  `departures` marks only devices the object knows, which is the direction that keeps rows. If it
  then acks within its token's last day it is enrolled, and pins the floor until the TTL or the
  next roster.
- **A device already gone before this deploys keeps pinning** until the group's next rotation posts
  a roster, or ninety days after the deploy — the constructor's backfill counts every existing
  device as heard at the moment it ran.

There are two internal paths, **`drop`**, which empties a group's log, its acks and its size for
§7.1, and **`roster`**, above. **Neither is on the router's public pattern** — the Worker builds
those requests itself, `claim.ts` when a membership ends and `rotate.ts` when a rotation is
recorded, and a device asking for either is a 404 like any other path that is not a route.

### The browser: CORS, and a socket a page can open

**Until 2026-10-04 every caller was the app's own Rust process, and there was no CORS code here
because nothing needed any.** The light app's web build at `https://mtg-grimoire.app` runs the
same sync engine as WASM and asks the same routes with `fetch`, cross-origin, so a browser now
stands between the engine and every answer. `src/cors.ts` and `src/ticket.ts` are the whole of
what that took; **neither changes what any route does, and a request with no `Origin` — every
desktop and Android build — is answered byte for byte as before.**

**It weakens nothing, because no route trusts a cookie.** CORS protects a server that
authenticates by something the browser attaches unasked. Every route here is guarded by something
the caller must hold and send — a token, a code, a secret. **So the allow-list is not an access
control**: a caller that is not a browser sends any `Origin` it likes, or none. It bounds which
*pages* a browser lets ask.

| | |
| --- | --- |
| The allow-list | `APP_ORIGINS` in `wrangler.jsonc`'s `vars` — comma-separated, shipped as exactly `https://mtg-grimoire.app`. Entries are trimmed and compared to the `Origin` header **exactly**: no wildcard, no suffix, no case folding, no trailing slash. Unset or empty allows nobody and throws at nobody. |
| Routes that take CORS | `POST /claim`, `POST /token`, `GET`/`POST /p/{rv}/{offer,join}`, `POST /g/{group}/rotate`, `GET /g/{group}/keys`, `POST /g/{group}/push`, `GET /g/{group}/pull`, `POST /g/{group}/ack` — every route a device calls with `fetch`. |
| Routes that do not | `/oauth/patreon/callback` and `/pair` (pages a browser navigates to), `/webhook/patreon` (Patreon's server), and `/g/{group}/ws` (an upgrade, which CORS does not govern). |
| A pre-flight | `OPTIONS` on a CORS route, from an allowed origin, carrying `Access-Control-Request-Method` → **`204`** with `Access-Control-Allow-Origin: <that origin>`, `Access-Control-Allow-Methods: <the route's own>`, `Access-Control-Allow-Headers: authorization, content-type`, `Access-Control-Max-Age: 86400`, `Vary: Origin`. |
| Every other answer to an allowed origin | the route's own response plus `Access-Control-Allow-Origin: <origin>` and `Vary: Origin` — **refusals included**: 400, 401, 403 `device_limit`, 405, 409, 413, 422, 429, and whatever a Durable Object said. |
| Anything else | no `Origin`, an `Origin` not on the list, or a path that takes no CORS: exactly what it was answered before. An `OPTIONS` there is still the `405` with `allow`, or the `404`. |

- **The pre-flight is answered before the router is entered** — before the rate limiter, D1, the
  HMAC and any Durable Object. A browser sends one unasked and without credentials, so it spends
  none of the caller's rate-limit budget and never bills an object request.
- **The refusals are the reason for the header, not an afterthought.** A browser hides a
  cross-origin response that lacks it — status and body both — and reports a network error. The
  engine reads a 401 as a statement about a membership, a `device_limit` as not one, a 409
  `stale_epoch` as "catch up"; each would become "the relay is unreachable".
- **A response is rebuilt, never mutated**: one that came back from a Durable Object stub has
  immutable headers, and writing to them throws.
- **No `Access-Control-Allow-Credentials`** — there is no cookie. **No
  `Access-Control-Expose-Headers`** — the engine reads the status and the body and no response
  header, a 429's `retry-after` included.
- ⚠️ **`Access-Control-Allow-Headers` is a list the engine must stay inside.** A header the engine
  starts sending that is not `authorization` or `content-type` fails every request from the web
  app and none from the desktop. `platform::http` sets no `User-Agent` on wasm for this reason.

**The socket is opened with two sub-protocols**, `grimoire.live.v1` and `bearer.<access>`:

- **The gate reads the `bearer.` entry when there is no `Authorization: Bearer`** — for `ws` and no
  other action. Every character `token.ts` mints (`A–Z a–z 0–9 - _ .`) is a legal sub-protocol
  character, so nothing is escaped.
- **The 101 selects `grimoire.live.v1` if and only if the request offered it**, and never echoes
  the bearer. A browser fails a connection whose offered sub-protocols were all ignored; a native
  client that offered none gets the bare 101 it always got.
- **An `Origin` that is present and not on the allow-list is a `403`**, before the gate and before
  the object. CORS does not apply to an upgrade, so the list is enforced by hand here. Absent —
  the desktop, Android — is not foreign.
- **The keepalive is the text frame `ping`, answered `pong` by the runtime**
  (`setWebSocketAutoResponse`), because a page cannot send the protocol ping the native client
  sends every 45 s. The object is not woken and no duration is billed.

⚠️ **Three things about it that are stated rather than discovered:**

- **A browser's keepalive is probably not free on the request line.** Cloudflare's pricing page
  (read 2026-10-04) exempts incoming *protocol* pings by name, bills other incoming messages at
  twenty to one, and says of auto-response only that it costs no duration. Read as written: 1 920
  frames a day for a tab open all day is **96 billed Durable Object requests**, 32 for an
  eight-hour session — against ~25 a day for an idle group of native devices. See Cost.
- **The token in a sub-protocol is recorded by Workers Logs where `Authorization` is redacted.**
  Invocation logs redact a header by its *name* — `cookie`, or one containing `auth`, `key`,
  `secret`, `token` or `jwt` — and `sec-websocket-protocol` is none of those. With
  `observability` on, a browser's access token sits in this account's logs for their retention. It
  is good for at most a day and readable only by whoever can already read the signing key.
- **The 101's `Sec-WebSocket-Protocol` has never met a browser.** `ticket.test.ts` runs the real
  `Group.ws()` over stand-ins for `WebSocketPair` and a `Response` that accepts a 101, which Node's
  does not; whether workerd passes the header through to the client is settled by the first socket
  the web app opens.

## Where the logic is

`src/log.ts` — `since`, `compact`, `departures` and the roster's parse and ordering, as pure
functions over a row list, tested by the **root** vitest
(`npm run test:run -- relay/src/log.test.ts`); and the numbers they and a push are held to — `TAIL_MS`, `ACK_TTL_MS`, `HEARD_REFRESH_MS`,
`MAX_SEALED_CHARS`, `MAX_GROUP_LOG_CHARS`, `MAX_CLOCK_AHEAD_MS`. **The sealed cap and the clock bound
are spelled for a grep as much as for a compiler**: `sync_engine::wire` and `sync_engine::hlc` read
this file with `include_str!` for the line that declares their number, so reformatting either turns
a Rust test red.

`src/admit.ts` — every refusal a push can meet, as pure functions in the order they are met: the
Worker's checks ahead of the Durable Object hop (`admitBody`, `admit`), the object's quota
(`admitToLog`), and the one envelope predicate both sides share (`isEnvelope`).

`src/token.ts` — mint and verify. Pure, and tested the same way.

`src/entitlement.ts` — a Patreon patron status plus a clock to `active`/`grace`/`dead`. Pure.

`src/md5.ts` — MD5 and HMAC-MD5, taking the digest as a parameter so the root vitest can supply
Node's and the Worker can supply `crypto.subtle`. Tested against RFC 2202.

`src/patreon.ts` — the code exchange, the identity fetch, and `verifyWebhook` (itself pure and
tested).

`src/claim.ts` — the callback landing page, the code mint, `/claim`, `/token`, the webhook and the
cron's reconciliation, with its budget and interval.

`src/groupauth.ts` — the group key store and the device roll: `seedGroup`, `recordRotation`,
`currentManifest`/`manifestAt`, `authIsCurrent`/`authIsRecent`, and
`liveDeviceCount`/`admitDevice`/`keepOnly`/`forgetGroup`, plus the constants (`EPOCH_HISTORY`,
`REMOVAL_STEP`, `MAX_GROUP_DEVICES`, `DEVICE_TTL_MS`) that anything else capping, stepping or
pruning must import rather than respell.

`src/rotate.ts` — `POST /g/{group}/rotate` and `GET /g/{group}/keys`, the two routes that stand
ahead of the bearer gate, and `sendRoster`, the one request either makes to a Durable Object.

`src/group.ts` — the Durable Object: its tables (`log`, `acks` with `heard_at`, `departed`,
`roster_epoch`, `log_size`), the handlers — the internal `drop` and `roster` among them — and a
call into `log.ts` for every decision about which rows and into `admit.ts` for the quota.

`src/index.ts` — the router, the auth gate, and a push's admission ahead of the object hop: the one
D1 point read for the group's epoch, then `admit.ts`'s decision. Since 2026-10-04 `fetch` is a
wrapper around `route`: it answers a pre-flight before the router is entered and dresses the
router's answer for an allowed origin, and for every other request hands `route`'s response back
untouched.

`src/cors.ts` — `allowedOrigin`, `preflight` and `withCors`: the allow-list's exact match, the 204,
and the rebuilt response. Pure, and tested through `worker.fetch` in `cors.test.ts`, where each
answer is asked for twice — without an `Origin` and with one — and compared.

`src/ticket.ts` — what a browser's socket needs: `bearerTicket` (the `bearer.` sub-protocol the
gate reads for `ws` alone), `selectedProtocol` (what the 101 names), and `KEEPALIVE`, the
`ping`/`pong` pair `group.ts` registers with the runtime. `ticket.test.ts` drives the gate, the
functions, and the real `Group` over stand-ins for workerd's globals.

`src/fakeD1.ts` — the test double, and it **evaluates** SQL rather than matching shapes: it holds
a `PRIMARY_KEY` map so that an upsert conflicts the way D1 would. Import it; never write a second.
⚠️ **A table missing from that map makes its cap tests vacuous** — "a device already counted does
not consume a second slot" passes trivially against a table that cannot hold a duplicate anyway.

**Why the split.** `@cloudflare/vitest-pool-workers` would run the real class in workerd, but it
pulls wrangler and workerd into the tree and peers on `vitest ^4.1.0` (0.22.0, checked
2026-09-27), which does not cover the vitest 5 this suite runs. Compaction, who the floor waits
for, the pull window, the thirty-day tail, a push's admission, token minting, the status decision
and the HMAC are all pure functions of their inputs, so they are testable without any of that, and
what is left in the Durable Object and the handlers is SQL and routing — where a bug is a 500 in a
log rather than a reader's data quietly disappearing. `rotate.test.ts` and `admit.test.ts` drive
`worker.fetch` itself, because where those routes and refusals stand relative to the gate is half
of what they are; the object there is a recorder, never workerd. `cors.test.ts` and
`ticket.test.ts` do the same for the browser's half. **`ticket.test.ts` is the one suite that
constructs the real `Group`**, over a stand-in state and with three of workerd's globals stubbed:
Node's `Response` refuses a status of 101, so without the stub `ws()` cannot return under vitest
at all. It proves which header `ws()` puts on its 101 and that the constructor registers the
auto-response — not that workerd honours either.

Two things a deploy verifies that no test here can, and both fail loudly on the first request to
an object rather than quietly:

- **`seq INTEGER PRIMARY KEY AUTOINCREMENT`.** `AUTOINCREMENT` is not decoration — a plain rowid is
  reused after a delete, so a compaction pass that emptied the log would restart `seq` at 1 and
  every device holding a cursor of 5 would silently skip the next five rows. If workerd's SQL
  dialect refused it, `CREATE TABLE` would throw.
- **The constructor's own migration.** A Durable Object has no migration step: an object created
  before `acks.heard_at` existed adds it on its first wake after the deploy, when `PRAGMA
  table_info(acks)` does not list it, and backfills it with that moment — every existing device
  counts as heard at the deploy, so none drops off the floor. **Whether workerd accepts `PRAGMA
  table_info` there is untested**, and every constructor asks it, a new object's included — so if
  it does not, every request that reaches any group's object 500s. The first pull after the deploy
  is the check.

## Deploying

Four steps, in order, and the first two are why `npx wrangler deploy` alone is not enough. The full
runbook, with the probes that say which of them are already done, is
[hosted-relay-deploy.md](../docs/reference/hosted-relay-deploy.md).

1. `npx wrangler d1 create mtg-grimoire-relay`, then put the id it prints into
   `wrangler.jsonc`'s `d1_databases[0].database_id`. **Already done** — the committed value is a
   real uuid, not the `<set on create>` placeholder this step described until 2026-08-30, so the
   database exists and step 2 runs against it rather than creating it. Only that command can
   produce a real id, and a plausible-looking uuid invented here would be a value that gets copied
   into documentation and deployed against.
2. **The schema. `--file=./schema.sql` is for an empty database only** — on any other, run the
   migrations in `migrations/` instead:
   ```
   # empty database only
   npx wrangler d1 execute mtg-grimoire-relay --remote --file=./schema.sql

   # every other database
   npx wrangler d1 execute mtg-grimoire-relay --remote --file=./migrations/2026-08-30-group-keys.sql
   npx wrangler d1 execute mtg-grimoire-relay --remote --file=./migrations/2026-08-30-group-devices.sql
   npx wrangler d1 execute mtg-grimoire-relay --remote --command "ALTER TABLE entitlements ADD COLUMN group_epoch INTEGER"
   npx wrangler d1 execute mtg-grimoire-relay --remote --command "ALTER TABLE entitlements ADD COLUMN group_auth TEXT"
   npx wrangler d1 execute mtg-grimoire-relay --remote --command "CREATE TABLE IF NOT EXISTS pairing_rendezvous (rv TEXT NOT NULL, slot TEXT NOT NULL CHECK (slot IN ('offer', 'join')), blob TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (rv, slot))"
   npx wrangler d1 execute mtg-grimoire-relay --remote --command "ALTER TABLE entitlements ADD COLUMN refresh_device TEXT"
   npx wrangler d1 execute mtg-grimoire-relay --remote --command "ALTER TABLE entitlements ADD COLUMN reconciled_at INTEGER"
   npx wrangler d1 execute mtg-grimoire-relay --remote --command "CREATE INDEX IF NOT EXISTS entitlements_reconcile ON entitlements (reconciled_at, subject) WHERE status <> 'dead'"
   ```
   The last two are `migrations/2026-09-28-reconciled-at.sql`, in that order — the index names the
   column — and **before the deploy that ships the budgeted `reconcile`**. Check the column landed
   with `--command "SELECT reconciled_at FROM entitlements LIMIT 0"`: empty is the pass, `no such
   column` means the `ALTER` did not run. **A Worker without the column fails quietly**: nothing a
   device calls reads it, so sync is untouched, but every hourly `scheduled` throws on its `SELECT`
   — no subject is reconciled, and the rendezvous sweep that runs after it never runs either. The
   Durable Object's own new column and tables need no step; see "Two things a deploy verifies"
   above.

   ⚠️ **The migration files exist because `wrangler d1 execute --file` is atomic**, which is the
   whole of the reason and is worth reading before deciding to skip one. `schema.sql` ends with
   its `ALTER TABLE ... ADD COLUMN`s, D1 has no `ADD COLUMN IF NOT EXISTS`, and adding a column
   that is already there is an error — so on a database those columns have reached, **the
   `ALTER`s fail and take every `CREATE` above them down with them**, including ones that come
   first in the file and would have succeeded alone. **That is measured, not theoretical**: it is
   what the 2026-08-30 deploy did to `CREATE TABLE group_keys`, and `/g/{group}/keys` answered a
   **500** — `no such table` — against a Worker whose schema execute had reported nothing wrong.
   Each `ALTER` above is its own invocation so that a `duplicate column name`, which is the
   *correct* answer on a database that already has it, costs nothing else.

   ⚠️ **`group_devices` goes in BEFORE the deploy that ships `admitDevice`.** Both `/token` doors
   call it on every trip, so a Worker pointed at a database without that table answers 500 on the
   route every device uses to sync. The reverse order costs nothing: a table nothing writes to yet
   is inert.
3. Set the three secrets. The public `vars` are already committed beside `RELAY_BASE`: the two
   Patreon ids and, since 2026-10-04, `APP_ORIGINS` — which a deploy carries with it and no
   command sets.
4. `npx wrangler deploy`, then register the redirect URI and the webhook with Patreon. **Verify
   against the host and never against an exit code** — that is what the 500 above was.

**Three secrets, never in this repository and never in a committed `.dev.vars`:**

| Secret | Used by |
| --- | --- |
| `PATREON_CLIENT_SECRET` | the OAuth code exchange, and the reconciliation's token refresh |
| `PATREON_WEBHOOK_SECRET` | `X-Patreon-Signature` verification |
| `RELAY_HMAC_KEY` | minting and verifying `access` |

Each is set with `npx wrangler secret put <NAME>`. **Spec §9 *listed* a fourth,
`PATREON_CREATOR_TOKEN`, and this implementation never had one**: the cron reconciles each
subject through the reader's own stored `patreon_refresh` rather than reading the campaign's
member list, so there is no campaign-wide credential to hold. **§9 was corrected to three on
2026-08-29, for this reason** — this paragraph is why that row went, not a standing
disagreement with a table that still carries it. If reconciliation ever moves to the campaign
endpoint, that secret comes back with it.

`PATREON_CLIENT_ID` and `PATREON_CAMPAIGN_ID` are **public** and are committed in `vars` beside
`RELAY_BASE`, both real. `required()` in `patreon.ts` still turns an unset binding into a 500
that names it, rather than into a request Patreon rejects for a reason nobody can see.

**`RELAY_BASE` must equal `entitlement::RELAY_BASE` in the Rust byte for byte.** The redirect URI
is built from it on both sides and Patreon compares redirect URIs exactly — at the authorize
request and again at the exchange. A trailing slash on either side fails the exchange with
`invalid_grant`, which says nothing about a path.

**Rotating `RELAY_HMAC_KEY` invalidates every outstanding `access` token.** Readers recover
silently on their next refresh, within 24 hours, without touching Patreon. That is the intended
break-glass and it is worth having written down.

## Cost

Limits verified live 2026-08-29. **Every relay request bills twice** — one Worker invocation and
one Durable Object request — **except one the auth gate refuses, which bills only the Worker.**
That exception is the whole reason the gate is where it is. ⚠️ **Two more routes joined that
exception on 2026-08-30**: `/keys` never reaches a Durable Object, and `/rotate` reaches one only
once D1 has accepted the rotation — one DO request per accepted rotation, a handful in a group's
life — so every refusal either makes bills one Worker invocation and D1 reads, which never bind.
`/claim` and `/token` were always in that group. **A push refused by its admission** — too large,
the wrong epoch, the clock ahead — **bills the same way**, a Worker invocation and at most one D1
point read, and never the object request it would have cost inside.

| | Free | Paid ($5/mo) |
| --- | --- | --- |
| Worker requests | 100 000/**day** | 10 M/mo, then $0.30/M |
| **Durable Object requests** | 100 000/**day** | **1 M/mo**, then $0.15/M |
| DO duration | 13 000 GB-s/day | 400 000 GB-s/mo, then $12.50/M GB-s |
| DO SQLite storage | 5 GB | 5 GB-month, then $0.20/GB-month |
| DO rows written | 100 000/day | 50 M/mo |
| D1 | 5 GB, 5 M reads/day, 100 k writes/day | — |

Per group — three devices, plus about four token refreshes a day, since a 24-hour token with a
six-hour margin refreshes a little over once per *device* per day. **The device cap is what bounds
the worst case at all**: five devices is the ceiling since 2026-08-30, so no group can be more
than ~1.7× any row below, where before it was unbounded.

**Re-derived 2026-08-31** (design spec §11) now that live sync pays for a socket rather than a
poll: what a group spends now tracks what it *does*, not a cadence every device pays alike
regardless of whether anybody is at the keyboard.

| | DO requests/group/day | Groups on **free** |
| --- | --- | --- |
| Idle group — connected, nobody editing | ~25 | ~4 000 |
| Busy group — 50 edits → ~20 debounced bursts, 3 devices | ~225 | ~440 |
| Manual — the **Sync now** button, still there as a fallback | ~70 | ~1 400 |

⚠️ **A browser is not in that table, and it is the first client whose idle is not free.** The
rows above are native devices, whose keepalive is a protocol ping Cloudflare does not bill. A page
cannot send one, so the web app sends the text `ping` every 45 s and the runtime answers it
without waking the object — no duration. **The request line is another matter**: the pricing page
(read 2026-10-04) bills incoming WebSocket messages at twenty to one and exempts only protocol
pings by name, so as written each open tab costs **4.8 billed requests an hour** — 32 for an
eight-hour session, 96 for a tab left open all day, on top of whatever its group does. Against
100 000 a day that is about a thousand tabs open round the clock before anything else is counted.
Not measured: nothing is deployed, and whether the dashboard counts an auto-answered frame is
something only a live socket shows. **A browser also pays a Worker request per pre-flight**, and
pre-flights reach no object. A browser remembers one per *URL*, query string included, for up to
`Access-Control-Max-Age` — two hours in Chromium, a day in Firefox — so `/push`, `/ack` and
`/token` are asked about once in that time, and **a pull is asked about nearly every time**: its
URL carries `since=`, which moves whenever the log did. That is one more Worker invocation per
pull from a tab, against the 100 000 a day the Worker has, and nothing against the object's.

Storage never binds: 484 KB/group against 5 GB is ~10 000 groups — and the per-group quota is the
fence on the other side of that figure, since at 128 MiB a group some forty groups at the cap would
fill it. Duration never binds. D1 never binds: the gate reads no storage at all, and the one D1
point read a push adds is paid only by a push that has passed the gate — at most one per Worker
request, so the free plan's 100 000 requests a day bound it at 2% of D1's 5 M reads. That last
bound is arithmetic, not a measurement.

Two conclusions:

- **The cost is edit-driven, not clock-driven.** A poll is paid whether or not anybody is using
  the app; this is paid only when somebody edits, so it cannot run away on its own — a busy group
  costs about 3× an idle one paying for nothing, and that multiplier tracks how much editing
  actually happens rather than a timer that ticks regardless of it.
- **The free plan's 100 000/day is a cliff, not a slope.** Past it every reader starts erroring
  simultaneously, so without warning the first signal is complaints.

**Decided 2026-08-29: stay on the free plan, and add a Cloudflare notification at ~70% of the
daily request cap — and that decision stands.** Even the busiest cadence this design pays for, a
group with somebody editing constantly, still leaves about 440 groups fitting inside the free
tier, and a merely-connected idle group is closer to 4 000; paying now would buy headroom against
numbers no reader is near. What the alarm buys is the thing the free tier otherwise lacks —
warning instead of complaints — and it costs nothing. **The notification matters more now than it
did**, because what a group spends is reader-driven — how much its devices edit — rather than a
fixed cadence every device paid alike. Going paid stays a one-switch change if the alarm ever
fires.

**KV is ruled out of the hot path**: 1 000 writes/day on the free plan. **No R2.** One
SQLite-backed Durable Object per pairing group, one D1 table beside it, and nothing else.

## The WebSocket is built — and two of the three reasons below were about the wrong socket

⚠️ **Superseded 2026-08-31.** This section used to argue `/g/{group}/ws` stayed a `501`. It is
built now — see
[the live-sync design](../docs/superpowers/specs/2026-08-31-live-sync-design.md). The three
reasons below are kept as history: two of them were about a WebSocket opened **from the page**,
and the one that shipped opens from the app's own Rust process instead, so neither blocker
survived contact with where the socket actually lives.

`GET /g/{group}/ws` now upgrades to a hibernatable WebSocket, behind the same bearer gate every
`/g/…` route sits behind — `/rotate` and `/keys` excepted — and, for a browser, with the token in
a sub-protocol rather than a header ("The browser", above). On every push the Durable Object
sends the group's other connected sockets a `{"t":"head","cursor":N,"from":"<device>"}` frame —
no card data, ever — and a device that hears one runs the ordinary HTTP round trip above. The
socket only ever decides *when* that trip happens; a frame is a hint, never the cursor advancing
on its own.

1. **"`reqwest` has no WebSocket client, and `tokio-tungstenite` does not compile to
   `wasm32-unknown-unknown`."** True, and it turned out not to be the obstacle it looked like:
   nothing on the wasm target named the crate — it and `sync_engine::live`, the one module that
   touches it, were both gated to the other targets. The web and Android builds were removed on
   2026-09-27, and those gates with them.
2. **"A socket from the page would need the CSP widened."** It would not, and this is the half the
   record had backwards: `connect-src 'self' ipc: http://ipc.localhost` governs the **webview's**
   connections, and the socket that shipped is opened by `tokio-tungstenite` inside the app's Rust
   process — the same process that already reaches this relay over `reqwest` under that exact CSP.
   `tauri.conf.json` was not touched. A fourth reason the record never named: a browser's own
   `WebSocket` cannot set an `Authorization` header, so a socket from the page would have forced
   the bearer gate above onto a query parameter or a subprotocol. Opening it from Rust needed no
   change to the gate at all. **On 2026-10-04 a page did need one** — the web app has no Rust
   process to open it from — and the gate took the subprotocol, for `ws` alone and only when
   there is no header: "The browser", above. The desktop's socket is still opened from Rust and
   still sends the header.
3. **"Polling is comfortably inside the free tier."** There never was a poll to be comfortable —
   see [sync.md](../docs/reference/sync.md) for that correction. The cost of what shipped instead
   is re-derived in the design spec §11: an idle, connected group costs about ~25 DO requests/day,
   a busy one (50 edits, 3 devices) about ~225, against the manual ~70/day the table above
   measures — three times the manual figure at the busiest, and paid only when somebody edits
   rather than on every tick of a clock. The free plan and the ~70% notification stand.

What changed: one device's edit now reaches another connected device within a few seconds, rather
than at the next **Sync now** press. What did not: the CSP still grants nothing.
