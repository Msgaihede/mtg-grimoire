# Deploying the hosted relay — the runbook, and what only a deploy can settle

**Nothing here has been run.** The code landed on 2026-08-29 in `e5ff435`, `86a9b8e` and
`612a01e`, with `npm run verify` green (249 test files, 5 932 frontend tests, 1 786 Rust),
`cargo fmt --check` clean, and both clippy legs clean — host `--all-targets` and
`--lib --target wasm32-unknown-unknown`, which CI runs and `verify` does not.

Design: [2026-08-29-hosted-relay-and-patreon-design.md](../superpowers/specs/2026-08-29-hosted-relay-and-patreon-design.md).

**No agent may run any of this.** `wrangler dev --local` is the only wrangler command an agent may
run — it runs workerd locally, contacts nothing and needs no login. Everything below is Markus's.

---

## What exists, and what does not

| | |
| --- | --- |
| `mtg-grimoire-relay.denmark-east.workers.dev` | **live**, running the pre-entitlement code — push, pull, ack, no authentication. It is what the 2026-08-29 end-to-end pass ran against. |
| This design's Worker code | **written, not deployed.** The auth gate, `/claim`, `/token`, the OAuth callback, the webhook, the D1 binding and the cron are all in `relay/` and have never executed. |
| The D1 database | **does not exist.** `wrangler.jsonc`'s `database_id` is `<set on create>`. |
| The Patreon OAuth app | **does not exist.** `PATREON_CLIENT_ID` and `PATREON_CAMPAIGN_ID` are absent from `vars` on purpose — `required()` turns each into a 500 naming it, which is louder than a committed guess. |

A device pointed at that host today reaches a live relay that 404s every endpoint the app now
calls. **The address is real; the code behind it is not this code yet.**

---

## The order

1. **`npx wrangler d1 create mtg-grimoire-relay`**, then put the real `database_id` into
   `relay/wrangler.jsonc`.
2. **Apply the schema to an empty database**, and verify rather than trusting exit 0 —
   see [the CHECK trap](#the-check-constraints-are-a-one-shot) below.
   ```
   npx wrangler d1 execute mtg-grimoire-relay --remote --file=./schema.sql
   ```
3. **Create the Patreon OAuth client.** Register the redirect URI as
   `https://mtg-grimoire-relay.denmark-east.workers.dev/oauth/patreon/callback` — **byte for
   byte**, no trailing slash. Put `PATREON_CLIENT_ID` and `PATREON_CAMPAIGN_ID` into
   `wrangler.jsonc`'s `vars`; both are public.
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
8. **Add rate-limiting rules on `/claim` and `/token`.** The bill argument in `index.ts` —
   "junk is refused for the price of a Worker invocation alone" — holds for `/g/…` and **not** for
   these two, which are unauthenticated by necessity and cost a D1 read each.

---

## What only the deploy can settle

Nine things, in the order they will bite.

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

**Every statement in `schema.sql` is `CREATE TABLE IF NOT EXISTS`**, so applying it to a database
where `entitlements` already exists is a silent no-op — and the `status` and `grace_until > 0`
constraints never arrive. Apply to an **empty** database, then verify with `PRAGMA table_info` or
`sqlite_master` rather than trusting exit 0. Free today; a table rebuild after the first apply.

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

---

## Known limitations, written down rather than discovered

- **A claim founds a group of one**, so a device that has claimed can no longer *join* another
  group — `pairing::complete` refuses a differing group id, and there is no Leave or Disconnect in
  the UI. **Connect on the device you will pair *from*, or pair first.** The panel says so; this is
  the note for when somebody asks why.
- **The sealed pairing blob is unversioned and its layout changed.** An old build and a new one are
  mutually unreadable, in both directions, and both report "That pairing key is unreadable".
- **No tier check exists.** Any pledge of any size entitles. The campaign filter is the gate that
  matters — a pledge to another creator does not entitle.
- **The OAuth `state` never returns to the app**, so it is unverifiable end to end. It is received
  and not checked.
- **Nothing sweeps expired `claim_codes`.** Rows for codes never redeemed accumulate; the cron does
  not touch that table.
- **Non-2xx, non-401 relay answers surface verbatim** — a claim against a lapsed membership shows
  "the relay answered 403 to /claim". Both 403 and 409 are states a reader can reach.
- **`entitlement::clear` has no production caller** — there is no Disconnect control. Four doc
  comments explain themselves in terms of a button that does not exist yet.
