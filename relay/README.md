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

**What is deployed at that address today is the pre-entitlement Worker.** The host is real — it
is what the 2026-08-29 end-to-end pass ran against — but the code on it has no auth gate, no
`/claim`, no `/token`, no OAuth callback, no webhook and no D1 binding. A device pointed there
now reaches a live relay that answers none of the endpoints the app calls, which fails as a 404
from a server that is there rather than as a name that will not resolve. Deploying this tree is
`npx wrangler deploy` from this directory, and it is the last of the four steps under
**Deploying** below rather than the whole of them.

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
`{sub, grp, exp}`, with a **24-hour** TTL (`TOKEN_TTL_MS`). The app trades its long-lived
`refresh` secret for a new one when fewer than six hours remain. That split is what makes lapse
work: deleting `refresh_secret` is instantaneous, and an already-issued `access` dies of old age
within a day.

**The four claim-layer routes are deliberately not behind the gate, and each is guarded by
something else.** `/oauth/patreon/callback` by the authorization code Patreon redirects with,
`/claim` by a single-use code that expires in ten minutes, `/token` by the refresh secret it is
presenting, and `/webhook/patreon` by its HMAC. A bearer token could not guard any of them —
three of the four exist precisely because the caller has no token yet.

## The entitlement table

One D1 table, `relay/schema.sql`. The Patreon adapter is the only Patreon-shaped code in the
design; everything downstream reads `status` and never asks who vouched, so **adding Paddle later
is one adapter file, one webhook route, and rows with a different `source`.**

```
entitlements(
  subject         TEXT PRIMARY KEY,   -- minted here, and NOT the Patreon user id
  source          TEXT NOT NULL,      -- 'patreon' today; 'paddle' later
  external_id     TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('active','grace','dead')),
  grace_until     INTEGER CHECK (grace_until IS NULL OR grace_until > 0),
  group_id        TEXT,               -- bound on first claim, trust-on-first-use
  refresh_secret  TEXT,               -- NULL once revoked; this is what revocation clears
  patreon_refresh TEXT,               -- the reader's own token, for the daily reconciliation
  created_at      INTEGER NOT NULL,
  checked_at      INTEGER NOT NULL
)
```

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
redirect, needs no CSP change, and the flow is byte-identical on desktop, Android and web.

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

**`/claim` carries the group id and that is not optional.** The token payload is `{sub, grp, exp}`
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

The daily cron reconciles rows that webhooks missed and closes expired grace windows. It refreshes
**each subject's own stored Patreon token** rather than reading the campaign through a creator
token, which is why there are three secrets below and not the spec's four. A row with no stored
token still gets its window settled, and an identity document the code cannot parse **throws
rather than deciding** — `decide(null, …)` is `dead`, right for a reader Patreon says has no
membership and catastrophic for one shape change on Patreon's side, which would otherwise become a
mass revocation in a job nobody is watching.

**Patreon API v1 retires 2026-10-07. This uses v2 exclusively.**

## The endpoints

The `/g/…` family lives on one Durable Object, addressed by `idFromName(group)`. Every one of them
is behind the bearer gate.

| Request | Body | Answer |
| --- | --- | --- |
| `POST /g/{group}/push` | one `Envelope` | `200 {"cursor": <seq>}` — the stored row's seq |
| `GET /g/{group}/pull?since={cursor}&device={id}` | — | `200 {"envelopes": [...], "cursor": <head>}` |
| `POST /g/{group}/ack` | `{"device": id, "cursor": n}` | `204` — and compaction runs |
| `GET /g/{group}/ws` | — | `501`. See "What is not built" |

`{group}` is constrained to `[A-Za-z0-9_-]{1,128}`, from **one** shared constant that `claim.ts`
applies to the group id in a `/claim` body as well. Without the constraint, `%41` and `A` would
name two different Durable Objects that a reader would read as one group, and there is no later
point at which that becomes visible; without sharing it, a claim could bind a group id the router
can never carry — a claim that succeeds and a sync that can never work.

The entitlement layer's four routes are fixed paths, matched ahead of that pattern:

| Request | Guarded by | Answer |
| --- | --- | --- |
| `GET /oauth/patreon/callback?code=…` | the authorization code | an HTML page carrying the claim code |
| `POST /claim {code, group}` | the one-time code, ten minutes | `{access, refresh, expires, status, since}`; `409` if that membership or that group is already bound elsewhere |
| `POST /token {refresh}` | the refresh secret | the same five fields, or `401` once revoked |
| `POST /webhook/patreon` | `X-Patreon-Signature` (HMAC-MD5) | `204`, or `401` unverified |

There is a fifth internal path, `drop`, which empties a group's log for §7.1. **It is not on the
router's public pattern** — the Worker builds that request itself, and no device can ask for it.

**A push whose envelope names a different group is refused with 409.** A Durable Object is
addressed by id, and the id is derived from the same path segment — so a body that disagrees has
reached an object that is not its own. That is either a client bug worth seeing or an attempt to
write into somebody else's log.

**The cursor a pull hands back is the head of the whole log, not of the returned slice.** The
slice has the puller's own rows filtered out of it, and a cursor taken from the slice would sit
below them, so the device would re-ask for its own rows on every pull for as long as they survived
compaction.

## Where the logic is

`src/log.ts` — `since`, `compact` and `TAIL_MS`, as pure functions over a row list, tested by the
**root** vitest (`npm run test:run -- relay/src/log.test.ts`).

`src/token.ts` — mint and verify. Pure, and tested the same way.

`src/entitlement.ts` — a Patreon patron status plus a clock to `active`/`grace`/`dead`. Pure.

`src/md5.ts` — MD5 and HMAC-MD5, taking the digest as a parameter so the root vitest can supply
Node's and the Worker can supply `crypto.subtle`. Tested against RFC 2202.

`src/patreon.ts` — the code exchange, the identity fetch, and `verifyWebhook` (itself pure and
tested).

`src/claim.ts` — the callback landing page, the code mint, `/claim`, `/token`, the webhook and the
cron's reconciliation.

`src/group.ts` — the Durable Object: two `sql.exec` tables, the handlers, and a call into `log.ts`
for every decision about which rows.

`src/index.ts` — the router and the auth gate.

**Why the split.** `@cloudflare/vitest-pool-workers` would run the real class in workerd, but it
pulls wrangler and workerd into a tree pinned to vitest 4.1.10 whose support it does not
advertise. Compaction, the pull window, the thirty-day tail, token minting, the status decision
and the HMAC are all pure functions of their inputs, so they are testable without any of that, and
what is left in the Durable Object and the handlers is SQL and routing — where a bug is a 500 in a
log rather than a reader's data quietly disappearing.

The one thing a deploy verifies that no test here can: `seq INTEGER PRIMARY KEY AUTOINCREMENT`.
`AUTOINCREMENT` is not decoration — a plain rowid is reused after a delete, so a compaction pass
that emptied the log would restart `seq` at 1 and every device holding a cursor of 5 would
silently skip the next five rows. If workerd's SQL dialect refused it, `CREATE TABLE` would fail
loudly on the first request rather than quietly.

## Deploying

Four steps, in order, and the first two are why `npx wrangler deploy` alone is not enough:

1. `npx wrangler d1 create mtg-grimoire-relay`, then put the id it prints into
   `wrangler.jsonc`'s `d1_databases[0].database_id`. **The committed value is the placeholder
   `<set on create>`** — only that command can produce the real one, and a plausible-looking uuid
   in this file is a value that gets copied into documentation and deployed against, where one
   that cannot resolve is caught by the first person who tries it.
2. `npx wrangler d1 execute mtg-grimoire-relay --remote --file=./schema.sql`.
3. Set the three secrets, and add the two public `vars` beside `RELAY_BASE`.
4. `npx wrangler deploy`, then register the redirect URI and the webhook with Patreon.

**Three secrets, never in this repository and never in a committed `.dev.vars`:**

| Secret | Used by |
| --- | --- |
| `PATREON_CLIENT_SECRET` | the OAuth code exchange, and the reconciliation's token refresh |
| `PATREON_WEBHOOK_SECRET` | `X-Patreon-Signature` verification |
| `RELAY_HMAC_KEY` | minting and verifying `access` |

Each is set with `npx wrangler secret put <NAME>`. **Spec §9 lists a fourth,
`PATREON_CREATOR_TOKEN`, and this implementation does not have one**: the cron reconciles each
subject through the reader's own stored `patreon_refresh` rather than reading the campaign's
member list, so there is no campaign-wide credential to hold. If reconciliation ever moves to the
campaign endpoint, that secret comes back with it.

`PATREON_CLIENT_ID` and `PATREON_CAMPAIGN_ID` are **public** and belong in `vars` beside
`RELAY_BASE` the day they are known. Both are deliberately absent rather than empty for step 1's
reason; `required()` in `patreon.ts` turns an unset binding into a 500 that names it, rather than
into a request Patreon rejects for a reason nobody can see.

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
That exception is the whole reason the gate is where it is.

| | Free | Paid ($5/mo) |
| --- | --- | --- |
| Worker requests | 100 000/**day** | 10 M/mo, then $0.30/M |
| **Durable Object requests** | 100 000/**day** | **1 M/mo**, then $0.15/M |
| DO duration | 13 000 GB-s/day | 400 000 GB-s/mo, then $12.50/M GB-s |
| DO SQLite storage | 5 GB | 5 GB-month, then $0.20/GB-month |
| DO rows written | 100 000/day | 50 M/mo |
| D1 | 5 GB, 5 M reads/day, 100 k writes/day | — |

Per group — three devices, plus about four token refreshes a day, since a 24-hour token with a
six-hour margin refreshes a little over once per *device* per day:

| Cadence | Requests/day/group | Groups on **free** | 1 000 groups, **paid** |
| --- | --- | --- | --- |
| **Manual (what ships today)**, ~10 syncs/device | ~70 | **~1 400** | **~$5.20** |
| 5-minute poll | ~580 | ~170 | ~$9.60 |
| 60-second poll | ~2 900 | **~34** | ~$41 |

Storage never binds: 484 KB/group against 5 GB is ~10 000 groups. Duration never binds. D1 never
binds — the hot path reads no storage at all.

Three conclusions:

- **The poll cadence is the entire cost model.** Data volume is irrelevant; a 5× change in the
  interval is a 5× change in the bill. Sync is manual today, so the scheduler is a separate
  decision and the table above is what to take it with.
- **Even the worst case is ~4¢ per patron per month.** Billing here is not really about recouping
  cost — it is about not waking to an unbounded bill.
- **The free plan's 100 000/day is a cliff, not a slope.** Past it every reader starts erroring
  simultaneously, so without warning the first signal is complaints.

**Decided 2026-08-29: stay on the free plan, and add a Cloudflare notification at ~70% of the
daily request cap.** At the cadence that actually ships, ~1 400 groups fit inside the free tier, so
paying now would buy headroom against a number no reader is near. What the alarm buys is the thing
the free tier otherwise lacks — warning instead of complaints — and it costs nothing. Going paid
stays a one-switch change if the alarm ever fires.

**KV is ruled out of the hot path**: 1 000 writes/day on the free plan. **No R2.** One
SQLite-backed Durable Object per pairing group, one D1 table beside it, and nothing else.

## What is not built: the WebSocket

§7.7 of the spec says the Durable Object "fans out to connected devices over hibernatable
WebSockets". This ships HTTP pull-and-push instead, and `/g/{group}/ws` is a `501` that keeps the
route in the object's shape. Three reasons:

1. **`reqwest` has no WebSocket client**, and `tokio-tungstenite` does not compile to
   `wasm32-unknown-unknown` — which would make the web target's core un-buildable.
2. **A socket from the page would need the CSP widened.** `tauri.conf.json` grants
   `connect-src 'self' ipc: http://ipc.localhost` and nothing else. Widening it is a decision to
   take once, for all three targets, in the PR where the browser's own `WebSocket` is available.
3. **Polling is comfortably inside the free tier**, as the table above shows — and it is the
   *manual* row that ships, which is cheaper still.

What is lost is latency: a change made on a phone shows on the desktop within a minute rather than
instantly. What is kept is a core that still compiles to wasm and a CSP that still grants nothing.
