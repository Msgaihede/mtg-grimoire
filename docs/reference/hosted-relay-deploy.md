# Deploying the hosted relay — the runbook, and what only a deploy can settle

**Nothing here has been run.** The first half landed on 2026-08-29 in `e5ff435`, `86a9b8e` and
`612a01e`, with `npm run verify` green (249 test files, 5 932 frontend tests, 1 786 Rust),
`cargo fmt --check` clean, and both clippy legs clean — host `--all-targets` and
`--lib --target wasm32-unknown-unknown`, which CI runs and `verify` does not. **Those three
figures are that day's tree and have not been re-derived**; the counts move with every branch, so
take them as the record of one green run rather than as today's number.

**A second half landed on 2026-08-30** — `/token`'s group door, `POST /g/{group}/rotate`,
`GET /g/{group}/keys`, the `group_keys` table and two columns on `entitlements`. It changes what
step 2 applies and adds two routes to what step 6 deploys, and it has been run no more than the
first half has.

Designs: [2026-08-29-hosted-relay-and-patreon-design.md](../superpowers/specs/2026-08-29-hosted-relay-and-patreon-design.md)
and [2026-08-30-group-wide-membership-and-removal-design.md](../superpowers/specs/2026-08-30-group-wide-membership-and-removal-design.md).

**No agent may run any of this.** `wrangler dev --local` is the only wrangler command an agent may
run — it runs workerd locally, contacts nothing and needs no login. Everything below is Markus's.

---

## What exists, and what does not

| | |
| --- | --- |
| `mtg-grimoire-relay.denmark-east.workers.dev` | **live, and running the entitlement Worker.** Probed 2026-08-30: `/claim` and `/token` answer **405** (the route is there and wants POST), `/oauth/patreon/callback` **400**, `/g/{group}/pull` **401** from the bearer gate, `/g/{group}/push` **405**, and `/nonsense` **404** — so the gate, the callback and the membership flow are all deployed. |
| This design's **two new routes** | **not deployed.** `/g/{group}/rotate` and `/g/{group}/keys` both answer **404** against a host that 405s its siblings, which is the shape of a router that has not been updated rather than a Worker that is not there. Everything else in `relay/` is running. |
| The D1 database | **exists.** `wrangler.jsonc`'s `database_id` is a real uuid, and has been since before this branch. It may hold live entitlement rows, so step 2's `ALTER TABLE`s run against real data. |
| The Patreon OAuth app | **the client exists.** `PATREON_CLIENT_ID` is real in `entitlement.rs` since `a0eb0c6` (2026-08-30) and was verified live: `GET /oauth2/authorize` with it and `/oauth/patreon/callback` answered 302 to Patreon's login, preserving both parameters, which an unregistered id or an unregistered redirect does not do. **What is still absent from `wrangler.jsonc`'s `vars` is the relay's own copy of it and `PATREON_CAMPAIGN_ID`** — on purpose, because `required()` turns each into a 500 naming it, which is louder than a committed guess. |

A device pointed at that host today reaches a relay that speaks the whole membership flow and
the whole log, and 404s only the key distribution this branch adds. **The address is real and so
is the code behind it; what is missing is one router change and two columns.**

⚠️ **Every row above was the opposite until 2026-08-30, in four files at once**, and no build
could go red for any of it. The claim "the hosted Worker is not deployed" was written once and
then repeated into `CLAUDE.md`, `src-tauri/CLAUDE.md` and `relay/README.md` — where it was read
back as corroboration. Two `curl`s settled it in a second. **That is what step 0 is for, and it
is the reason it comes before everything else.**

⚠️ **Two things are called "the relay" at one hostname, and every sentence in this file is about
telling them apart.** The **baseline** relay is the three unauthenticated endpoints and it is
deployed and driven; the **hosted** relay is everything in the table's second row and it is not.
`docs/reference/sync.md` records a 2026-08-29 pass in which a desktop and a phone converged "over
the deployed relay" — that was the baseline one, pointed at by hand through `sync_state.relay_url`.
**Neither this file nor `src-tauri/CLAUDE.md` has ever claimed the hosted code ran.** But the
distinction is exactly the kind that rots, and a deploy is expensive to get wrong, **so step 0
below settles it by asking the host rather than by reading any of us.**

---

## The order

0. **Ask the host what is actually there, and branch on the answer rather than on this file.**
   Two `curl`s settle it in ten seconds and cost nothing:
   ```
   curl -si https://mtg-grimoire-relay.denmark-east.workers.dev/token -d '{}'
   curl -si "https://mtg-grimoire-relay.denmark-east.workers.dev/g/aaaa/keys?device=bbbb"
   ```
   **A 404 on both is the expected answer** and means the baseline Worker is still there: run
   every step below. **Anything else — a 400, a 401, a JSON error body — means some version of
   this design is already deployed**, in which case steps 1 and 3 are done, `wrangler.jsonc`
   already carries a real `database_id`, and **step 2 becomes the dangerous one**: see
   [the CHECK trap](#the-check-constraints-are-a-one-shot) and take the branch there. Do not skip
   this step because the table above says the host is un-upgraded; the table is prose and prose
   rots, and `curl` does not.
1. **`npx wrangler d1 create mtg-grimoire-relay`**, then put the real `database_id` into
   `relay/wrangler.jsonc`.
2. **Apply the schema to an empty database**, and verify rather than trusting exit 0 —
   see [the CHECK trap](#the-check-constraints-are-a-one-shot) below.
   ```
   npx wrangler d1 execute mtg-grimoire-relay --remote --file=./schema.sql
   ```
   ⚠️ **The two `ALTER TABLE`s at the foot of `schema.sql` error on a second run, and that is the
   file working.** `group_epoch` and `group_auth` were added on 2026-08-30 and could not go into
   the `CREATE TABLE entitlements` above them: that statement is `IF NOT EXISTS` and does nothing
   at all on a database that already holds the table, so a column written there would reach a
   fresh deploy and never an existing one. D1 has no `ADD COLUMN IF NOT EXISTS`. **On an empty
   database the whole file applies cleanly; on a database created before 2026-08-30 the `CREATE`s
   no-op and only the two `ALTER`s do work; on a database that already has them the two `ALTER`s
   are `duplicate column name` and nothing else in the file has changed.** Read the errors rather
   than counting them — an error naming anything but `group_epoch` or `group_auth` is a real one.
3. **Create the Patreon OAuth client** — **already done as of 2026-08-30**, and this step is now
   the two halves of it that are not. The client and its redirect URI
   `https://mtg-grimoire-relay.denmark-east.workers.dev/oauth/patreon/callback` are registered and
   were verified live (see the table above). What is left is to put `PATREON_CLIENT_ID` into
   `wrangler.jsonc`'s `vars` **byte for byte equal to `entitlement::PATREON_CLIENT_ID`** — this
   side builds the authorize URL, the relay builds the exchange, and Patreon compares them — and
   to add `PATREON_CAMPAIGN_ID` beside it. Both are public.
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
6. **`npx wrangler deploy`.**
7. **Add the free-tier ceiling alarm** — a Cloudflare notification at ~70% of the 100 000/day
   request cap. Decided 2026-08-29: stay free, watch the ceiling. The ceiling is a **cliff, not a
   slope** — past it *every* reader errors at once, so without the alarm the first signal is
   complaints.
8. **Add rate-limiting rules on `/claim`, `/token`, `/g/{group}/rotate` and `/g/{group}/keys`.**
   The bill argument in `index.ts` — "junk is refused for the price of a Worker invocation alone"
   — holds for the three routes behind the bearer gate and **not** for these four, which each
   cost a D1 read before anything can refuse them. ⚠️ **This step named two until 2026-08-30**:
   `/rotate` and `/keys` are `/g/…` routes that deliberately stand *ahead* of the gate, because a
   device that has just been rotated away from cannot mint a token and `/keys` exists to answer
   exactly that device. Neither reaches a Durable Object, so the metered line is untouched — but
   "unauthenticated at the edge" is what a rate-limit rule is about, and by that test they belong
   on this list rather than on the other one.

---

## What only the deploy can settle

Ten things, in the order they will bite.

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

### 8. The secrets before first traffic

`RELAY_HMAC_KEY` unset makes every authenticated request a 500. That is deliberate — `token.ts`
does not catch it, on the grounds that an unset key should be loud rather than silently 401ing
every reader.

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
  nine rotations, confirm `group_keys` holds eight rows and that the oldest surviving auth is
  still accepted by `/keys`.

---

## Known limitations, written down rather than discovered

- **A claim founds a group of one**, so a device that has claimed can no longer *join* another
  group — `pairing::complete` refuses a differing group id, and there is no Leave or Disconnect in
  the UI. **Connect on the device you will pair *from*, or pair first.** The panel says so; this is
  the note for when somebody asks why. **Pairing in the other order stopped being a dead end on
  2026-08-30** — a device that pairs first and never connects is now entitled through its group —
  but the group-of-one trap this bullet names is unchanged, because it is about `complete`
  refusing a differing group id and not about entitlement.
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
- ~~**`entitlement::clear` has no production caller**~~ — **it has one since 2026-08-30.**
  `client::check_keys` calls it beside `identity::leave_group` when `/keys` answers a higher epoch
  with no blob, because a removed device that kept its refresh secret would keep a *working
  credential for the group it was removed from*: the refresh door mints a token whose `grp` is
  that group and `/g/{group}/push` honours it, so the rotation would stop it reading anything new
  while it went on spending the group's requests. **`clear` and never `revoke`**, because nothing
  ended — the reader's pledge is untouched and this device simply left a group, so the panel draws
  *Not connected* rather than *Membership ended*. What is still absent is the **Disconnect
  control** those doc comments name, and that is now the only sense in which the button does not
  exist.
