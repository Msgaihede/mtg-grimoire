# The Hosted Relay: One Address, and Patreon as the Gate

**Status:** design, approved 2026-08-29.

**Supersedes** [the cross-platform design](2026-08-27-cross-platform-design.md) §7.7's premise that
each reader deploys their own relay, and the three documents that state in bold that the relay's
address is nowhere in this repository — root `CLAUDE.md`, [`relay/README.md`](../../../relay/README.md)
and [sync.md](../../reference/sync.md). **After this change the address IS in the repository.** What
must never be in it are the four secrets named in §9.

**Goal:** a reader who supports the project on Patreon presses one button, pastes one code, and
their devices sync through infrastructure Markus runs — with no Cloudflare credential anywhere in
the shipped binary, and with the entitlement enforced by the relay rather than by the app.

---

## 1. What is being changed, and why now

The relay was built on the assumption that a reader deploys their own Cloudflare Worker. That was
never the intent. It is a Worker, a Durable Object namespace, a `wrangler` install and a URL typed
into Settings on every device — against an app whose whole pitch is a portable exe you copy onto a
stick. Nobody will do it.

**The timing is not incidental. Every installation has `sync_state.relay_url` empty**, which is the
state sync ships in, so adding authentication to the wire costs no migration. This is the only
moment at which it is free, and the wire currently has no authentication at all.

A reader who wants their own relay still can: this repository is public, `relay/` is the whole
source, and a fork changes one constant.

---

## 2. Vocabulary: what a group is

`sync_pair::identity::Group` is `{group_id, epoch, group_key}`. **A pairing group is one reader's
set of paired devices** — a desktop and a phone are one group with two devices; adding a laptop
keeps the same group. A different reader is a different group and a different Durable Object,
sharing nothing.

**One group is one patron.** That is the unit of entitlement and the unit of cost, and it is why
every figure in §8 is per group rather than per device.

The Durable Object is addressed by `idFromName(group_id)`, so the group id *is* the storage
address. There is no directory of readers anywhere in the relay, and this design does not add one.

---

## 3. Three corrections to the record, found while designing this

Each of these is a load-bearing number that the existing documents get wrong.

**3.1 There is no polling. The scheduler was specified and never built.** `client::round_trip` has
exactly two callers in production, one through each of its wrappers: `sync_now`
(`sync_engine/commands.rs:208`) calls `run_once`, and the revoke path
(`sync_pair/pairing.rs:543`) calls `run_once_without_baselines`. *(An earlier draft of this
section named `run_once` for both — the revoke path deliberately uses the other wrapper, which
is §7's whole point about not baselining a device you are about to remove.)* In the frontend,
`ipc.syncNow()` is called from one place — a mutation
behind the **Sync now** button (`SyncPanel.tsx:483`). There is no `setInterval`, no
`refetchInterval` and no Rust timer. `client.rs`'s module doc and sync.md's "pull every 60 s while
the window has focus" describe a design, not shipped code. **Sync today is manual.**

**3.2 A round trip is 2–3 HTTP requests, not one.** `pull` and `ack` both fire on every round trip
once the device is in a group; `push` short-circuits at `Ok(0)` when nothing is pending
(`client.rs:291`) and `emit_baselines` sends only on first contact. sync.md's 1 440 req/day counted
pulls alone and understates by roughly 2×.

**3.3 A relay has been deployed.** `relay/README.md` and sync.md both say "nobody has deployed
this". [The baseline design](2026-08-29-sync-baseline-design.md) §1 records a live pass on
2026-08-29 with two devices "pointed at a deployed relay". The prose is stale on this point and is
corrected as part of this work.

---

## 4. The credential question, answered

**No Cloudflare credential is shipped.** A Cloudflare API token is account-scoped — it can delete
Workers, read logs and create resources — and a portable exe from a public repo would surrender the
account to `strings`. The app does not need one, because what it needs is not access to Cloudflare
but permission to write to one group's log.

Three constants change places:

| | Today | After |
| --- | --- | --- |
| Relay address | reader types it into `sync_state.relay_url` | compiled-in `RELAY_BASE`; `relay_url` survives as a **test/dev override with no UI** |
| Authorization | none — the 128-bit group id is the whole guard | HMAC-signed token on every request, verified in the Worker |
| Entitlement | n/a | Patreon membership, resolved server-side |

**`relay_url` stays as a `sync_state` key.** `sync_engine/client/tests.rs` stands a real HTTP server
on localhost for the length of each test and points the client at it. Deleting the key deletes
those tests. What is deleted is the *field* in Settings and the `sync_relay_url_set` command — which
is what "remove it entirely" meant.

### 4.1 What the binary contains

`RELAY_BASE` is public in exactly the way every application's API base URL is public. Anyone can
read it out of the binary, and nothing follows from that, because every endpoint requires a token
the relay issued.

### 4.2 What sits on the reader's disk

Two values in `sync_state`, beside the group key. `identity.rs` already states the standard they
are held to:

> The device's secret key and the group key live in the user database, in the clear. There is no
> OS keystore for a portable Windows exe a reader copies onto a stick, and inventing one would be
> a second store to lose. Somebody who has the database already has the collection it protects, so
> the key adds no new exposure.

Both tokens are **strictly weaker than that key**, and both are scoped to one group. An OS keychain
for them while the group key stays in SQLite would be ceremony, not defence.

---

## 5. The entitlement layer: one table, one adapter, room for a second

One D1 table in the relay. The Patreon adapter is the only Patreon-shaped code in the design.

```
entitlements(
  subject        TEXT PRIMARY KEY,   -- internal id, minted here, never external
  source         TEXT NOT NULL,      -- 'patreon' today; 'paddle' later
  external_id    TEXT NOT NULL,      -- patreon user id
  status         TEXT NOT NULL,      -- 'active' | 'grace' | 'dead'
  grace_until    INTEGER,            -- see §7.2
  group_id       TEXT,               -- bound on first claim
  refresh_secret TEXT,               -- NULL once revoked
  checked_at     INTEGER NOT NULL
)
```

Everything downstream — token minting, the auth gate, lapse handling — reads `status` and never
asks who vouched. **Adding Paddle later is one adapter file, one webhook route, and rows with a
different `source`.** Nothing in `token.ts`, `group.ts` or `log.ts` changes.

**D1 rather than KV**: KV allows 1 000 writes/day on the free plan. Rows here are read rarely and
written rarely, and the hot path (§6.2) touches no storage at all.

**`subject` is minted by the relay and is not the Patreon user id.** The Patreon id lives in one
column of one table; the token, the group binding and every log line refer to the subject. When
Paddle arrives, a reader who moves between the two keeps their subject and their group.

---

## 6. The flows

### 6.1 Claim — the browser hop lands on the relay, not on the app

1. Reader presses **Connect Patreon** in Settings. The app calls `sync_patreon_begin`, which
   returns the authorize URL, and opens it with `opener` — already granted on desktop, and narrowed
   to `opener:allow-open-url` on Android.
2. Patreon authorizes with scopes **`identity` and `identity.memberships`** and redirects to
   `GET {RELAY_BASE}/oauth/patreon/callback`.
3. The Worker exchanges the code at `https://www.patreon.com/api/oauth2/token`, calls
   `/api/oauth2/v2/identity?include=memberships&fields[member]=patron_status`, resolves the
   entitlement, and renders one page: **"You are connected. Paste this into MTG Grimoire:
   `XXXX-XXXX-XXXX`."**
4. Reader pastes it. `sync_patreon_claim(code)` calls `POST /claim`, which answers
   `{access, refresh}` and binds `group_id` if it is not yet bound.

**Why the redirect lands on the relay and not on a loopback listener.** The `client_secret` can
never be in the app, so the exchange must happen server-side regardless — a loopback listener would
buy a listener and nothing else. This way the app runs no HTTP server, handles no redirect, needs
no CSP change, and the flow is byte-identical on desktop, Android and web. It is also the same page
and the same paste field Paddle will reuse: **one reader-facing flow, two sources.**

**The claim code is Crockford base32 with a positional checksum**, reusing `sync_pair::invite`'s
existing alphabet and checksum rather than inventing a second one. That alphabet was chosen because
it omits `I`, `L`, `O` and `U` and folds the confusions a person makes copying between two screens —
which is exactly what this code is for. It is one-time and expires in 10 minutes.

### 6.2 The token — what is on the wire

`POST /claim {code, group}` and `POST /token {refresh}` both answer
`{access, refresh, expires, status, since}`.

**⚠️ Corrected 2026-08-29, twice, and both corrections are contract bugs no test on either side
would have caught.** This section first said `/claim {code}` answering `{access, refresh}`.

- **`/claim` must carry the group id.** The token payload is `{sub, grp, exp}` and the gate
  compares `grp` against the path segment — but `/claim` carries no `Authorization` header (the
  device has no token yet) and `claim_codes` has no group column, so with a body of `{code}`
  alone the relay is handed nothing to bind and nothing to stamp into `grp`. The claim would
  succeed and every later push, pull and ack would 401 on a group mismatch: a reader connects
  Patreon and then finds sync broken for ever.
- **`expires` and `since` are unix SECONDS on the wire.** The relay counts in milliseconds
  internally (`TOKEN_TTL_MS`, `nowMs`) and the app counts in seconds (`unixepoch()`, as
  `last_sync_at` already does), so the boundary has to pick one and say so. If milliseconds
  reached the app, `expires - now` would be ~1.7e12, always exceed the refresh margin, and the
  token would never be refreshed — the relay then 401s every sync request a day later, on the
  sync route rather than on `/token`, where nothing is watching for it. **Sync would die
  silently and permanently.** The relay converts; the app holds a magnitude guard so the unit
  cannot regress in silence.

- **`access`** is `base64url(payload) "." base64url(HMAC-SHA256(payload, RELAY_HMAC_KEY))` where
  payload is `{sub, grp, exp}`. **TTL 24 hours.**
- **`refresh`** is a long-lived opaque secret stored in `entitlements.refresh_secret`. The app
  trades it for a new `access` when fewer than 6 hours remain.

**Every relay request carries `Authorization: Bearer <access>`, and the Worker verifies it before
the Durable Object hop**: signature, expiry, and `payload.grp` against the path segment. Zero
storage reads, so verification is a few microseconds and **junk never costs a Durable Object
request** — which is the line that actually bills (§8).

This split is what makes §7 work. Deleting `refresh_secret` is instantaneous; an already-issued
`access` is useless within 24 hours.

**`refresh` rides to the second device inside the sealed pairing blob**, alongside the group key.
`sync_pairing_confirm` seals it and `sync_pairing_complete` stores it, so **device B never opens a
browser and never sees Patreon.** One membership, one group, any of that reader's devices.

### 6.3 Group binding is trust-on-first-use

A device has no group until it pairs — `client::me` returns `None` and `run_once` answers
`Ok(None)`. So `sync_patreon_claim` creates a group of one if the device is in none, then claims
against it. The entitlement binds to that group id on first claim and is refused for a second.

A reader who genuinely needs to rebind — a lost device, a reset — is a support action, not a
feature. It is one `UPDATE` and it is deliberately not automated.

---

## 7. Lapse

### 7.1 Cancellation deletes the log at once

`members:pledge:delete`, or a `members:update` that drops the reader below the tier, sets
`status = 'dead'`, clears `refresh_secret`, and calls the group's Durable Object to drop its log.

**Deleting the relay log destroys no reader data.** Every device holds the whole collection in its
own SQLite; the log is a transport buffer with a 30-day tail. Resubscribing resumes without
re-pairing, because the baseline emission already knows how to re-found a group from a device's own
state. The Settings copy must say this, so that a reader who lapses is not frightened.

### 7.2 A declined card is not a cancellation

`patron_status` is one of `active_patron`, `declined_patron`, `former_patron`. **A
`declined_patron` is a failed card, and Patreon retries it.** Deleting a reader's log because their
card expired is a punishment for something they did not decide.

So `declined_patron` sets `status = 'grace'` with `grace_until = now + 7 days`. A grace entitlement
still mints tokens. At expiry — or on a `members:update` that returns them to `active_patron`,
which clears it — the cron in §7.3 resolves it either to `active` or to `dead` and §7.1 runs.

`former_patron` and `pledge:delete` are `dead` immediately. This is the only softening of the
delete-at-once rule and it covers only the case where the reader did not choose to leave.

### 7.3 The webhook is primary, the cron is the backstop

Webhooks: `members:pledge:create`, `members:pledge:update`, `members:pledge:delete`,
`members:update`. Verified against `X-Patreon-Signature`, which is **the HEX digest of the body,
HMAC signed with MD5**, using the webhook secret. *(MD5 is Patreon's choice. HMAC-MD5 is sound for
authentication and the code carries a comment saying so, because the next reader will want to
"fix" it to SHA-256 and break every webhook.)*

**HMAC-MD5 has to be built by hand, and this is the one place the runtime does not simply
provide what is needed.** Verified against the Workers Web Crypto docs on 2026-08-29: MD5 *is*
available through `crypto.subtle.digest("MD5", …)` as a documented non-standard extension "for
interacting with legacy systems that require MD5" — but **HMAC's supported hashes do not include
it**, so `importKey`/`sign` is not a route. The construction is the standard one over two raw
digests:

```
HMAC(K, m) = MD5( (K' ^ opad) || MD5( (K' ^ ipad) || m ) )
```

Roughly fifteen lines, and it lands on the right side of this repository's testing split by
taking **the digest function as a parameter**: the root vitest supplies Node's
`crypto.createHash("md5")`, the Worker supplies `crypto.subtle.digest`, and the pure function
between them is tested against **RFC 2202's published HMAC-MD5 vectors** rather than against
whatever it happens to produce.

**A webhook that fails verification is refused and logged, never processed.** An unverified
`pledge:delete` deletes a reader's log, so failing open here is the one bug in this design that
would destroy data.

A **daily Cron Trigger** reconciles against the campaign members endpoint using a stored creator
token — catching webhooks that never arrived, and resolving expired grace windows. Cron Triggers
are on the free plan.

**Patreon API v1 retires 2026-10-07.** This design uses v2 exclusively.

---

## 8. Cost, recomputed

Cloudflare limits verified live 2026-08-29. **Every relay request bills twice** — one Worker
invocation and one Durable Object request — except one rejected by the auth gate, which bills only
the Worker.

| | Free | Paid ($5/mo) |
| --- | --- | --- |
| Worker requests | 100 000/**day** | 10 M/mo, then $0.30/M |
| **Durable Object requests** | 100 000/**day** | **1 M/mo**, then $0.15/M |
| DO duration | 13 000 GB-s/day | 400 000 GB-s/mo, then $12.50/M GB-s |
| DO SQLite storage | 5 GB | 5 GB-month, then $0.20/GB-month |
| DO rows written | 100 000/day | 50 M/mo |
| D1 | 5 GB, 5 M reads/day, 100 k writes/day | — |

Per group — three devices, plus about four token refreshes a day. *(A 24-hour token with a
six-hour margin refreshes a little over once per device per day, not once per group; an
earlier draft said three. The difference is inside the rounding of every figure below.)*


| Cadence | Requests/day/group | Groups on **free** | 1 000 groups, **paid** |
| --- | --- | --- | --- |
| **Manual (what ships today)**, ~10 syncs/device | ~70 | **~1 400** | **~$5.20** |
| 5-minute poll | ~580 | ~170 | ~$9.60 |
| 60-second poll | ~2 900 | **~34** | ~$41 |

Storage never binds: 484 KB/group against 5 GB is **~10 000 groups**. Duration never binds.

Three conclusions:

- **The poll cadence is the entire cost model.** Data volume is irrelevant; a 5× change in the
  interval is a 5× change in the bill.
- **Even the worst case is ~4¢ per patron per month.** A €3 tier keeps roughly 98% of it. Billing
  here is not really about recouping cost — it is about not waking to an unbounded bill.
- **The free plan's 100 000/day is a hard wall that errors for every reader once hit.** It is a
  cliff, not a slope: past it every reader starts erroring simultaneously, so without warning
  the first signal is complaints.

**Decided 2026-08-29: stay on the free plan, and add a Cloudflare notification at ~70% of the
daily request cap.** At the manual cadence that actually ships (§3.1), ~1 400 groups fit inside
the free tier, so paying now would buy headroom against a number no reader is near. What the
alarm buys is the thing the free tier otherwise lacks — warning instead of complaints — and it
costs nothing. Going paid stays a one-switch change if the alarm ever fires.

**Because sync is manual today (§3.1), the scheduler is a separate decision** and this design does
not take it. The table above is what to take it with.

---

## 9. Operations, and what stays out of the repository

The relay stops being source that type-checks and becomes a service with an uptime obligation:
a webhook endpoint Patreon needs to reach, a cron job, and four secrets set with
`wrangler secret put` — **never in this repository, and never in a `.dev.vars` that is committed**:

| Secret | Used by |
| --- | --- |
| `PATREON_CLIENT_SECRET` | the OAuth code exchange |
| `PATREON_WEBHOOK_SECRET` | `X-Patreon-Signature` verification |
| `PATREON_CREATOR_TOKEN` | the daily reconciliation cron |
| `RELAY_HMAC_KEY` | minting and verifying `access` |

`PATREON_CLIENT_ID` and `RELAY_BASE` are public and may be committed.

**Rotating `RELAY_HMAC_KEY` invalidates every outstanding `access` token.** Readers recover
silently on their next refresh, within 24 hours, without touching Patreon. That is the intended
break-glass and it is worth having written down.

---

## 10. What changes in the app

**Rust — `src-tauri/src/sync_engine/`**

- New `entitlement.rs`: `RELAY_BASE`, the `access`/`refresh`/`access_expires` `sync_state` keys,
  `claim(code)`, `refresh()`, and the `Authorization` header applied to every relay request.
- `client::relay_url()` falls back to `RELAY_BASE` when `sync_state.relay_url` is empty, instead of
  answering `None`. **The "sync is off" state stops being "no URL" and becomes "no entitlement"**:
  `round_trip` answers `Ok(None)` when there is no `refresh` secret, exactly as it does today for
  a device in no group, and that remains not an error.
- **A `401` is a sentence, not an `error_log` row.** When the relay refuses a token and the refresh
  also refuses, the membership has ended — the panel says so and offers the connect button again.
  Routing that through `errors::record` like a network failure would tell a reader their sync is
  broken when in fact their pledge lapsed, which is the wrong sentence and the wrong fix.
- New commands `sync_patreon_begin`, `sync_patreon_claim`, `sync_supporter_status`.
- `sync_relay_url_set` and `valid_relay_url` deleted.
- `sync_pairing_confirm` seals `refresh` into the blob; `sync_pairing_complete` stores it.

**TypeScript — `src/features/settings/SyncPanel.tsx`**

The URL field is replaced by a supporter block: a **Connect Patreon** button, a paste field for the
claim code, and a status line — *Supporting since …* / *Not connected* / *Membership ended*. The
lapse copy states that local data is untouched (§7.1). `ipc.ts` gains three commands and loses one.
Stories and tests follow.

**Relay — `relay/src/`**

- `token.ts` — mint and verify. **Pure, tested by the root vitest**, exactly the split `log.ts`
  established and for the same reason: the decision is a pure function, so it does not need workerd.
- `entitlement.ts` — a Patreon identity payload plus a clock to a `status`. Pure, tested.
- `patreon.ts` — the exchange, the identity fetch, and `verifySignature` (itself pure and tested).
- `claim.ts` — the callback landing page and the code mint.
- `index.ts` — the auth gate ahead of the DO hop, and the new routes.
- `wrangler.jsonc` — a D1 binding, a cron trigger, four secrets.

`group.ts` and `log.ts` are untouched but for the log-drop call §7.1 needs.

---

## 11. Testing

The existing split is the model: pure decisions in modules the root vitest can reach, I/O kept thin
enough that a bug there is a 500 in a log rather than a reader's data disappearing.

| What | Where | How |
| --- | --- | --- |
| Token mint/verify, tamper, expiry, group mismatch | `relay/src/token.test.ts` | root vitest, pure |
| `patron_status` → `status`, grace open and close | `relay/src/entitlement.test.ts` | root vitest, pure |
| HMAC-MD5 against **RFC 2202 vectors**, and a rejected signature | `relay/src/patreon.test.ts` | root vitest, pure, digest injected |
| A 401 reads as *membership ended*, not as an `error_log` row | `SyncPanel.test.tsx` | existing pattern |
| Claim, refresh, and the `Authorization` header on push/pull/ack | `sync_engine/client/tests.rs` | the existing localhost server, extended |
| A request with no token, a wrong-group token, an expired token | `sync_engine/client/tests.rs` | same |
| Pairing carries `refresh` to device B | `sync_pair::pairing` tests | existing pattern |

**What no test reaches is the real Patreon round trip** — the consent screen, the redirect, the
exchange, and a real webhook arriving. That needs a live pass against Markus's own campaign with a
second Patreon account, written up in `docs/superpowers/research/` the way this repository records
every other live-verified fact.

Per the working style in root `CLAUDE.md`, each implementing subagent is asked to **mutate its own
tests and report any assertion that survives the mutation.**

---

## 12. Documents this invalidates

A prose-only edit routes to neither CI job, so none of these go red on their own. They are part of
the work, not follow-up:

- **Root `CLAUDE.md`** — "its address is nowhere in this repository and must never be" and "the
  relay is a Cloudflare Worker the reader deploys themselves".
- **`relay/README.md`** — "Nobody has deployed this", the free-tier arithmetic (§8 supersedes it),
  and "There is no authentication on the endpoints and that is deliberate".
- **`docs/reference/sync.md`** — the section "The relay: three endpoints, and no authentication";
  the 1 440 req/day figure (§3.2); "Nothing is deployed" (§3.3).
- **`2026-08-27-cross-platform-design.md` §7.7** — the free-tier table and the self-deploy premise.

---

## 13. Out of scope, and named so it is not assumed

- **Paddle.** The `source` column and the adapter boundary exist for it; no Paddle code is written.
- **The poll scheduler.** Sync stays manual (§3.1). §8's table is what to decide it with later.
- **Hibernatable WebSockets.** Still blocked by `tokio-tungstenite` on `wasm32-unknown-unknown`.
  Worth recording that this is a **wasm-only** blocker — native targets could use it and the browser
  has its own `WebSocket` — so the eventual answer is a per-target transport, and it is *cheaper*
  than polling, not dearer.
- **A device cap per group.** The relay can count distinct devices in `acks` when it needs to. It
  does not need to yet.
- **Per-group rate limiting** beyond what the auth gate already refuses.
- **Key recovery by email.** A reader who loses everything re-runs the Patreon connect flow, which
  is idempotent. No email sender joins the tree.
