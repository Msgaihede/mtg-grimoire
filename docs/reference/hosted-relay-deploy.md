# Deploying the hosted relay — the runbook, and what only a deploy can settle

⚠️ **This file opened with "nothing here has been run" until 2026-08-30, and by the end of that
day two of its three halves had been.** What follows is the record of which, because the whole
value of this page is that it distinguishes them.

**The first half landed on 2026-08-29** in `e5ff435`, `86a9b8e` and `612a01e`, with
`npm run verify` green (249 test files, 5 932 frontend tests, 1 786 Rust), `cargo fmt --check`
clean, and both clippy legs clean — host `--all-targets` and `--lib --target wasm32-unknown-unknown`,
which CI runs and `verify` does not. **Those three figures are that day's tree and have not been
re-derived**; the counts move with every branch, so take them as the record of one green run
rather than as today's number. **It is deployed**: step 1 is done, step 6 has run, and step 3 is
done except for the two `vars` its own text still lists. **Two of step 4's three secrets are
provably set**, probed 2026-08-30 — `/g/{group}/pull` with a *malformed* bearer answers **401**
and not 500, and `required(env.RELAY_HMAC_KEY, …)` is called before `verify` can refuse it; the
same shape holds for `POST /webhook/patreon` with no signature, where `required(env.
PATREON_WEBHOOK_SECRET, …)` runs unconditionally ahead of `verifyWebhook`. `PATREON_CLIENT_SECRET`
is only reachable through a real code exchange, so it cannot be probed. **Steps 7 and 8 are
open.**

**A second half landed on 2026-08-30** — `/token`'s group door, `POST /g/{group}/rotate`,
`GET /g/{group}/keys`, the `group_keys` table and two columns on `entitlements`. **It is deployed
too**, and its deploy is where step 2's atomicity trap was measured rather than reasoned.

**A third half is in this branch and is not deployed**: `group_devices`, `MAX_GROUP_DEVICES`, a
required `device` field on both `/token` doors and on `/claim`, `/claim` moving a binding instead
of refusing it, and `/rotate` capping its manifest and freeing slots through `keepOnly`. It adds
**one migration file** to step 2 and changes no route path, so step 6 deploys the same list it
already did.

Designs: [2026-08-29-hosted-relay-and-patreon-design.md](../superpowers/specs/2026-08-29-hosted-relay-and-patreon-design.md),
[2026-08-30-group-wide-membership-and-removal-design.md](../superpowers/specs/2026-08-30-group-wide-membership-and-removal-design.md)
and [2026-08-30-leave-group-and-device-caps-design.md](../superpowers/specs/2026-08-30-leave-group-and-device-caps-design.md).

**No agent may run any of this.** `wrangler dev --local` is the only wrangler command an agent may
run — it runs workerd locally, contacts nothing and needs no login. Everything below is Markus's.

---

## What exists, and what does not

| | |
| --- | --- |
| `mtg-grimoire-relay.denmark-east.workers.dev` | **live, and running the entitlement Worker.** Probed 2026-08-30: `/claim` and `/token` answer **405** to a GET (the route is there and wants POST) and **400** to an empty POST body, `/oauth/patreon/callback` **400**, `/g/{group}/pull` **401** from the bearer gate, `/g/{group}/push` and `/g/{group}/ack` **405**, and `/nonsense` **404** — so the gate, the callback and the membership flow are all deployed. |
| The **group-key routes** | **deployed, later the same day.** `/g/{group}/rotate` answers **401** to a POST and `/g/{group}/keys` **401** to a GET carrying a well-formed bearer, against a host where `/g/{group}/bogus` is still **404** — so these are refusals from the handlers, not a router shrug. ⚠️ **This row said "not deployed, both answer 404" and that is history.** |
| The `group_keys` **table** | **applied.** The bearer-carrying `/keys` probe in step 2 is the test — **401 is the pass and 500 is a missing table** — and it answers 401. |
| This branch's **device roll** | **not deployed, and no route path gives it away.** The tell is a body: `POST /token {group, auth}` **with no `device`** answers **401** from the entitlement lookup, where this tree's code answers **400 `that is not a device id`** before reading anything. So `group_devices`, the cap, `/claim`'s rebind and `keepOnly` are all still un-run. |
| The D1 database | **exists.** `wrangler.jsonc`'s `database_id` is a real uuid, and has been since before this branch. It holds live entitlement rows, so step 2's `ALTER TABLE`s run against real data. |
| The Patreon OAuth app | **the client exists.** `PATREON_CLIENT_ID` is real in `entitlement.rs` since `a0eb0c6` (2026-08-30) and was verified live: `GET /oauth2/authorize` with it and `/oauth/patreon/callback` answered 302 to Patreon's login, preserving both parameters, which an unregistered id or an unregistered redirect does not do. **What is still absent from `wrangler.jsonc`'s `vars` is the relay's own copy of it and `PATREON_CAMPAIGN_ID`** — on purpose, because `required()` turns each into a 500 naming it, which is louder than a committed guess. |

A device pointed at that host today reaches a relay that speaks the whole membership flow, the
whole log **and the key distribution**. **What is missing is one table and one deploy**, and
neither is visible in a route list — which is the reason the last row's probe is a body rather
than a path.

⚠️ **The first two rows above were the opposite until 2026-08-30, in four files at once**, and no
build could go red for any of it. The claim "the hosted Worker is not deployed" was written once
and then repeated into `CLAUDE.md`, `src-tauri/CLAUDE.md` and `relay/README.md` — where it was read
back as corroboration. Two `curl`s settled it in a second. ⚠️ **And then it happened again inside
one day**: the group-key deploy landed, and the "both answer 404" row survived in this file and in
the three others until somebody probed again. **That is what step 0 is for, and it is the reason
it comes before everything else. Probe, then read; never the other way round.**

⚠️ **Two things are called "the relay" at one hostname, and every sentence in this file is about
telling them apart.** The **baseline** relay is the three unauthenticated endpoints; the
**hosted** relay is everything else. `docs/reference/sync.md` records a 2026-08-29 pass in which a
desktop and a phone converged "over the deployed relay" — that was the baseline one, pointed at by
hand through `sync_state.relay_url`, and it remains the only pass two real devices have driven end
to end. **The hosted code has since run**, which is what the table's first three rows say, but
nothing has driven a second device across it. The distinction is exactly the kind that rots, and a
deploy is expensive to get wrong, **so step 0 below settles it by asking the host rather than by
reading any of us.**

---

## The order

0. **Ask the host what is actually there, and branch on the answer rather than on this file.**
   Three `curl`s settle it in ten seconds and cost nothing:
   ```
   curl -si https://mtg-grimoire-relay.denmark-east.workers.dev/token -d '{}'
   curl -s -o /dev/null -w "%{http_code}\n" \
     -H "authorization: Bearer $(printf 'ab%.0s' {1..32})" \
     "https://mtg-grimoire-relay.denmark-east.workers.dev/g/abc/keys?device=deadbeef"
   curl -si https://mtg-grimoire-relay.denmark-east.workers.dev/token \
     -d '{"group":"aaaaaaaa","auth":"bbbbbbbb"}'
   ```
   **As of 2026-08-30 the expected answers are `400 malformed token request`, `401`, and
   `401 unauthorized`** — an upgraded Worker with `group_keys` applied and the device roll not yet
   deployed. Read them in that order and branch:
   - **404 on the first** means the baseline Worker is still there and none of this has run: do
     every step below.
   - **500 on the second** means the router is deployed and `group_keys` is **missing** — the
     exact state the 2026-08-30 deploy produced. Go to step 2's migration block. **401 is the
     pass**: the credential was well-formed, reached the D1 read and matched nothing. A bare
     `curl` with no header answers 401 either way, because `handleKeys` refuses a missing
     credential before it touches D1, which is what makes the header the whole point of this
     probe.
   - **400 `that is not a device id` on the third** means this branch is already deployed and the
     device roll's migration must already have been applied; **401** means it is not, and step 2's
     `group_devices` block is still owed.

   ⚠️ **The third probe is a body and not a path, and that is the lesson of the second deploy.**
   The device cap adds no route, so a route list cannot tell you whether it is live — and a route
   list is exactly what everybody reached for the first time. Do not skip this step because the
   table above agrees with you; the table is prose and prose rots, and `curl` does not.
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
   ```
   Both migration files are `IF NOT EXISTS` throughout and safe to run any number of times. Each
   `ALTER` is its own invocation so a `duplicate column name` — the correct answer on a database
   that already has it — costs nothing else.

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
   both of `seedGroup`'s statements now carry *this epoch must be at least the highest the group
   has*, the claim still succeeds and still mints a grant, and the key registration is left where
   it already correctly pointed. ⚠️ **Until this branch is deployed the hazard is live on the
   host**, so if this repair is needed before then, press Connect on a device that has just synced
   successfully — not on the one that has been failing.

   **Measured 2026-08-30**, on the real pair and on the first press of the pass: a paid-up,
   paired phone at epoch 2, `entitled: true`, `status: "active"` — and `sync_now` answering
   *the relay did not recognise this device's group key*. **No suite could have caught it**:
   every relay test starts from a group claimed under the new code, so "claimed before the
   migration" is a state the fixtures cannot express. It took a device with real history.
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

**Eleven things**, in the order they will bite. ⚠️ **Re-counted 2026-08-30** — it was ten until
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
  nine rotations, confirm `group_keys` holds eight rows and that the oldest surviving auth is
  still accepted by `/keys`.

### 11. The device roll, and the one refusal that must not read as a lapse

Added 2026-08-30, and **none of it has run**. Four things.

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

---

## Known limitations, written down rather than discovered

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
