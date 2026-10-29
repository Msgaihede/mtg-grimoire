# `infrastructure/integrations-worker/` — the integrations store

The fifth Cloudflare Worker, `mtg-grimoire-integrations`, beside the relay, the share Worker, the
web app's hosting and the scan inbox. It holds, for each sync group that switched integrations
on, a **projection** of the group's collection, wishlist and decks — six tables its devices
publish after a sync trip — so that an integration (Discord first) can answer questions about a
collection without being a device of the group, and propose additions to it that a device of the
group applies. Issue #1396; the design is
`docs/superpowers/specs/2026-10-24-integration-data-access-design.md` (option B, §6); the store
is `docs/superpowers/plans/2026-10-25-integrations-projection-store.md` (PR 2) and the inbox and
the consumer routes `docs/superpowers/plans/2026-10-29-integrations-intents.md` (PR 3).

**No integration holds a token yet.** A device can mint one (`POST /g/{group}/consumers/…`), and
the suite does; Discord's front is the issue's PR 4 and remote MCP its PR 5.

## Why it is a Worker of its own

For the share Worker's reason (its spec's §5.1): **a bad deploy here must not be a sync outage**.
It shares the relay's D1 database and the relay's signing key, and nothing else — no service
binding, no binding to the relay's Durable Objects, no bucket — and it imports one module of the
relay's, `src/token.ts`, to verify a token.

## What it holds, and what it never holds

**Per group, one `GroupStore` Durable Object** (`src/object.ts`, `src/store.ts`), addressed by
`idFromName(group)`, on SQLite storage:

- the six projected tables' rows, each **sealed whole** (below) beside a few clear index columns —
  its `sync_uid`, Scryfall id, normalised name, set, collector number, finish, quantity, the uid
  of what holds it, and kind (`src/projection.ts`'s `clearColumns`) — and the generation it was
  sealed in and a keyed MAC of it, which is how a publish finds the rows that did not change;
- each table's digest, the publisher's watermark (its `sync_clock` reading) and row count;
- **the inbox**: the intents its integrations wrote — `collection.add` and `wishlist.add`, nothing
  else — each **sealed** (`{ payload, confirmedBy }`) beside the clear columns the overlay and the
  caps read: its id, source, kind, state, creation and ack times, the lease a device claimed it
  under, the watermark it was applied at, a refusal's reason, its name hint normalised and its
  folder's uid; and a count per integration per UTC day, for the cap;
- **one consumer token's id per integration** (`discord`, `mcp`), its scopes, when it was issued and
  when it ends — never the token, which is a MAC this object can make again and need not keep;
- the group's settings — its field policy, which of `condition`, `lang`, `value`, `tags`,
  `notes` the projection carries, and its marketplace, which of `tcgplayer`, `cardmarket`,
  `cardkingdom`, `manapool` its prices come from — and the group's data key, wrapped under
  `INTEGRATIONS_KEK`. **Both settings are the group's, not a device's**: two devices projecting
  under two policies, or pricing from two marketplaces, would overwrite each other's tables on
  every publish.

And in the relay's D1, **one row per group that has a store** (`integration_groups`,
`migrations/0001_integration-groups.sql`), which the lapse pass reads.

**It never holds the group key**, nor anything it could derive one from: the key manifest the
gate reads names devices, and the keys in it are sealed to them. **It never keeps a relay
token** past the request that carried it, and **it has no device identity**: it is not a member
of any group, and nothing here can read the sync log. **An intent is a proposal and never a
write**: nothing here reaches a device's database. A device of the group pulls the inbox, holds each
intent to its own allow-list (`grimoire_core::integration::intents`) whatever this Worker said of
it, applies what passes as its own write, and acks. The format leaves out, as absences and
never as switches, purchase price and currency, acquired-at, acquisition source, `needs_review`,
serial numbers, grading, deck descriptions, notes and tags, labels and to-dos.

**The store's existence is the group's switch** (plan §2). Its `integration_groups` row is the
lapse pass's index of switches: `PUT …/settings` writes it before making the store and again
after, and `DELETE /g/{group}` and the lapse pass, which delete it after emptying the store, ask
the object again and put the row back if a store was made in between — so a switch-on racing a
switch-off never leaves a store no lapse could find. `PUT …/settings` with `create: true` makes
it; `DELETE /g/{group}` empties it; nothing else makes one — not a projection `PUT`, and not a
change of settings (`create: false`), so a device that has not heard of a switch-off cannot bring
back what was deleted. Changing the policy or the marketplace drops every table at once, so
narrowing the policy takes the notes off the server before any device republishes, and no price
from the old marketplace is left beside the new.

## The routes

Every route is behind the door — the share Worker's `authorised`, copied into `src/gate.ts`: a
relay token verified with `RELAY_HMAC_KEY`, `claims.grp` equal to the path's group, and the
token's device still on the group's newest key manifest (issue #548). There is no public route.
Refusals are `{ "error": "<sentence>", "code": "<code>" }`.

| Route                                       | Body                                                                                           | Answers                                                                                                                                                                                                                                    |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /g/{group}/projection/digests`         | —                                                                                              | 200 `{ fields, marketplace, tables: { "<table>": { digest, hlcMs, hlcCtr, rows, publishedAt } } }`; 404 `no_store`                                                                                                                         |
| `PUT /g/{group}/settings`                   | `{ "fields": { condition, lang, value, tags, notes }, "marketplace": "<id>", "create": bool }` | 200 `{ fields, marketplace, created }`; 404 `no_store` (`create: false` and no store: nothing made); 400 `bad_settings`                                                                                                                    |
| `PUT /g/{group}/projection/{table}`         | the gzipped document; `x-projection-hlc-ms`, `x-projection-hlc-ctr`, `x-projection-digest`     | 200 `{ table, digest, rows, hlcMs, hlcCtr }`; 404 `no_store`; 409 `stale_projection` (with the held `hlcMs`/`hlcCtr`); 409 `settings_mismatch` (with the store's `fields` and `marketplace`); 413 `projection_limit`; 400 `bad_projection` |
| `DELETE /g/{group}`                         | —                                                                                              | 204, whether or not there was a store — and every consumer token of the group dead with it                                                                                                                                                 |
| `GET /g/{group}/intents?since=<ms>`         | —                                                                                              | 200 `{ intents, more }` — pending, oldest first, at most 200; 404 `no_store`                                                                                                                                                               |
| `POST /g/{group}/intents/{id}/claim`        | —                                                                                              | 200 `{ id, lease, leaseUntil }` (ten minutes); 409 `claimed`; 409 `already_acked` with `state`; 404 `no_intent`; 404 `no_store`                                                                                                            |
| `POST /g/{group}/intents/{id}/ack`          | `{ "state": "applied" \| "refused", "reason", "lease", "hlcMs", "hlcCtr" }`                    | 200 `{ id, state }`; 409 `claimed`; 409 `already_acked` with `state`; 400 `bad_ack`; 404 `no_intent`; 404 `no_store`                                                                                                                       |
| `GET /g/{group}/consumers`                  | —                                                                                              | 200 `{ consumers: [{ integration, scopes, issuedAt, exp }] }`; 404 `no_store`                                                                                                                                                              |
| `POST /g/{group}/consumers/{integration}`   | `{ "scopes": [...], "days": 1–365 }`                                                           | 200 `{ integration, token, scopes, exp }`, replacing the token it held; 400 `bad_consumer`; 404 `no_store`                                                                                                                                 |
| `DELETE /g/{group}/consumers/{integration}` | —                                                                                              | 204, whether or not it held one                                                                                                                                                                                                            |

- `{table}` is one of `collection_folders`, `collection_entries`, `wishlist_folders`,
  `wishlist_entries`, `decks`, `deck_cards`; any other is a 404, as is any path not above.
- **405 before 401**, naming the one method in `allow`; then the KEK; then the door.
- **Settings are exactly `fields` (the five booleans), `marketplace` (one of the four ids, the
  projection's own vocabulary: `share::snapshot::marketplace_id`) and `create`**; a missing, extra
  or ill-typed key is `400 bad_settings`.
- **The document is held to plan §3.1**: `v` is 1, `table` is the path's, `fields` lists known
  names in canonical order, `marketplace` is one of the four and `currency` is its currency (`EUR`
  for `cardmarket`, `USD` for the rest), each row has a non-empty string `uid` seen once, and
  every key is on the table's list for those fields — else `400 bad_projection`. Then `fields` and
  `marketplace` must equal the store's, else `409 settings_mismatch` with the store's, from which
  the device projects again. A key outside it — a
  purchase price, a note with notes off — refuses the whole document.
- **The watermark** is two non-negative safe integers in decimal; an older `(ms, ctr)` than the
  table holds is refused, an equal one accepted (a republish after a price change moves no
  clock). **The digest** is 64 lowercase hex characters, stored and handed back, never
  recomputed.
- **`409 stale_projection` is also "send it again"**, for two rarer cases: another device's
  publish of the same table kept overtaking this one mid-way, five rounds running; or the store
  was switched off and on again while this publish was in flight — the store that answers is a
  new one, under a new data key, and rows sealed under the old one would never open there. Each
  store has a random id (`meta.store_id`) that a publish holds itself to across its awaits. The
  device keeps the store as on and resends the table on its next round; `404 no_store` would tell
  it the store is off.
- **Eight megabytes as sent, twenty-four mebibytes inflated**, both counted rather than believed
  (`src/body.ts`); a declared `content-length` over eight is refused unread. Twenty-four is the
  largest measured document (a 50,000-card collection, 15.1 MiB of JSON) and half again: the
  first cap, sixty-four, was past what one isolate's 128 MB can hold while inflating and
  parsing, so a bomb under it reset the isolate rather than being refused. The text is decoded
  as it inflates and never held twice.
- `publishedAt`, and `integration_groups.created_at`, are Unix milliseconds.
- **A claim before an apply.** An add is a quantity: two devices that both applied one intent would
  add the card twice. So a device claims an intent (a ten-minute lease, `LEASE_MS`), applies only
  what it holds a lease on, and acks `applied` with the lease and its `sync_clock` after the write.
  A `refused` ack needs no claim — every device refuses an intent for the same reason — unless
  another device's lease is live. An ack repeating the held state is a 200 (an owed ack, sent
  again after a crash); another state is `409 already_acked`. An acked intent is kept thirty days
  for its integration to read, then forgotten at the next write to the inbox.
- `{id}` is 22 characters of base64url; `{integration}` is `discord` or `mcp`. Scopes are
  `collection:read`, `wishlist:read`, `decks:read`, `collection:add`, `wishlist:add`.

### The consumer routes

An integration's door is a **consumer token** this Worker minted on a device's request:
`gct1.<base64url(claims)>.<base64url(HMAC-SHA-256)>`, claims `{ grp, int, scp, exp, tid }`,
signed under a key HKDF draws from the group's data key (`src/consumer.ts`, `src/seal.ts`). The
router reads the claims, unverified, for one thing — which group's object to ask — and a bearer
whose claims do not parse, a relay token among them, is a 401 that reaches no object. The object
then verifies the MAC, `exp`, and that its row for the integration still holds the `tid`: a revoke
deletes the row, a re-mint replaces it, and `DELETE /g/{group}` takes the data key and with it the
key every token was signed under. **A consumer token opens no `/g/` route, and a relay token no
`/c/` route.** Any failure is the same `401 unauthorized`.

| Route                                                              | Scope                                                | Answers                                                                                                                                                                    |
| ------------------------------------------------------------------ | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /c/collection?q=&folder=`                                     | `collection:read`                                    | 200 `{ rows, more, publishedAt, fields, marketplace }` — at most 50 rows by name, then the overlay                                                                         |
| `GET /c/wishlist?q=&folder=`                                       | `wishlist:read`                                      | the same over the wishlist                                                                                                                                                 |
| `GET /c/decks?q=`                                                  | `decks:read`                                         | 200 `{ decks, more }`, at most 200                                                                                                                                         |
| `GET /c/decks/{uid}`                                               | `decks:read`                                         | 200 `{ deck, cards }`; 404 `no_deck`                                                                                                                                       |
| `GET /c/folders`                                                   | either read scope                                    | 200 `{ collection?, wishlist? }` — each list only under its scope, locked folders included                                                                                 |
| `GET /c/autocomplete?kind=collection\|wishlist\|decks\|folders&q=` | the kind's read scope (`folders`: `collection:read`) | 200 `{ choices: [{ name, value }] }`, at most 25                                                                                                                           |
| `POST /c/intents`                                                  | `collection:add` / `wishlist:add` by kind            | 200 `{ intent }`; 400 `bad_intent`; 403 `scope`; 413 `intent_too_large` (64 KiB, `MAX_INTENT_BYTES`); 429 `intent_quota` (64 a UTC day per integration, `INTENTS_PER_DAY`) |
| `GET /c/intents/{id}`                                              | any                                                  | 200 `{ intent }` — its own integration's only; 404 `no_intent`                                                                                                             |

- **A search** is a substring of the row's normalised name (`projection.ts`'s `normaliseName`), its
  `%` and `_` taken as text, at most 100 characters; `400 bad_query` past that, for a `folder` that
  is no uid, and for an autocomplete `kind` outside its four.
- **The overlay**: after the projection's rows, every intent of the read's kind (`collection.add`
  on the collection, `wishlist.add` on the wishlist) that is pending — or applied, with an ack
  watermark newer than the table's held one, or on a table never published — and matches the same
  search (by its `name` hint) and folder, as `{ uid: null, intentId, state, scryfallId, oracleId?
(a wish's), name, set?, cn?, finish, quantity, folderUid }`. **Not dropped at its ack**: the
  device acks before its own round publishes the table, and a device that cannot publish it leaves
  that to another — so an add is visible from the moment it is written until a published table
  carries it. A refused intent is never drawn.
- **An intent's body** is `{ kind, payload, confirmedBy }`, exactly; the scope for its kind is asked
  before its payload is read; the payload is the plan's §3.1 key set exactly (`src/intents.ts`).
  `source` is the token's integration, the id and the clock the Worker's.
- `/c/*` is for servers; a page at `APP_ORIGINS` is answered as on any route, and nobody else's.

**A browser** — the light app's web build at `https://mtg-grimoire.app`, which publishes too — is
answered by `src/cors.ts`, the scan inbox's three functions: a pre-flight from an origin on
`APP_ORIGINS` is a 204 allowing `authorization`, `content-type` and the three `x-projection-*`
headers, and every answer to that origin, refusals included, carries its
`access-control-allow-origin`. A request with no `Origin` is answered exactly as if the file did
not exist.

## Sealing, and rotating the KEK

`src/seal.ts` is envelope encryption (plan §2):

- **A data key per group**, 32 random bytes made with the store, stored wrapped — AES-256-GCM
  under `INTEGRATIONS_KEK`, the group id as associated data — beside the fingerprint of the KEK
  it is wrapped under.
- **A key per table generation**: HKDF-SHA-256 of the data key, naming the table and a
  generation that every publish which seals a row takes anew.
- **Each row**: AES-256-GCM under that key, a random 12-byte nonce, `table \0 uid` as associated
  data, stored as `nonce ‖ ciphertext` beside the generation it was sealed in — so rows sealed by
  different publishes open side by side, each under its own generation's key.
- **Each row's MAC**: HMAC-SHA-256 of `table \0`, the clear columns' version
  (`CLEAR_COLUMNS_VERSION`, so a change to how a clear column is derived rewrites every row on the
  next publish) and the row's canonical JSON (keys sorted), under
  a key HKDF draws from the data key with an info string of its own. **Keyed on purpose**: a
  storage dump holds the clear columns, and the sealed fields beyond them (a condition, a
  language) are few enough to guess — an unkeyed hash would confirm the guess; this one does not.

**AES-GCM and not XChaCha20-Poly1305**: WebCrypto has no XChaCha. What sealing protects against
is a copy of the storage alone; Cloudflare, running this Worker with its secret, can read every
row, and the app's privacy sentence says so. **A missing or short KEK is a 500 naming the
binding**, never a fallback key.

**Rotating the KEK** moves only the data keys — the rows are under those, and stay put:

1. From this folder, in the owner's terminal:
   `node ../wrangler/node_modules/wrangler/bin/wrangler.js secret put INTEGRATIONS_KEK_PREVIOUS`,
   with the **current** KEK's value.
2. Then `… secret put INTEGRATIONS_KEK` with a new one (below, for how to make one).
3. **Each store rewraps itself on its next request** (`store.ts`'s `#rotate`): its fingerprint
   says its key is under another KEK, so it opens it with `INTEGRATIONS_KEK_PREVIOUS` and wraps it
   under the new one, in one transaction. A group's devices ask the store on every publish round
   while integrations are on, so an active group is rewrapped within a day.
4. **Leave `INTEGRATIONS_KEK_PREVIOUS` set** until every group with a store has been asked —
   `integration_groups` lists them. A store asked after it is removed, still under the old KEK,
   is a 500 naming both bindings, and wipes nothing: put the old value back as the previous KEK
   and it rewraps. Then `… secret delete INTEGRATIONS_KEK_PREVIOUS`.

**The inbox and the tokens are under the data key too**, each by HKDF with a salt and info of its
own: intents sealed with AES-256-GCM under `intentKey` (associated data `intent \0 id`), and consumer
tokens signed with HMAC-SHA-256 under `consumerKey`. So **a KEK rotation moves no token**, and
`deleteAll` revokes every token of the group by taking the key.

`seal.ts`'s `rewrap(wrapped, group, oldKek, newKek)` is the one step, and `test/object.test.ts`
rotates a store end to end. **Losing the KEK loses every store's rows** — not the collections,
which are the devices', and which they publish again into a store made afresh by switching
integrations off and on.

## The lapse

`wrangler.jsonc`'s cron (`15 3 * * *`; the relay owns minute `0`, the share Worker `30 3`) runs
`src/lapse.ts`: every `integration_groups` row whose group no serving membership names — the
share Worker's `SERVING_GROUPS`, `active` or `grace` inside its window, with its NULL caveat — has
its object emptied and its row deleted, and then the object is asked again: a store made there in
the meantime gets its row back. **At most twenty-five a pass**: two D1 queries whatever the count
(and one for each store made again mid-pass), two Durable Object requests per store; a backlog
drains oldest first. A store whose object fails, or cannot be asked again, keeps its row and is
asked the next day. A lapsed store is not relit: the devices publish
it again once a revived membership switches integrations back on.

## What it costs

**A device sends a table whole; the store writes only what changed** (`src/store.ts`). A
Durable Object's SQLite counts each row written, a delete included (Cloudflare's Durable Objects
pricing page, read 2026-10-25: 100,000 a day on Workers Free, where a write past the allowance
fails rather than bills; 50 million a month included on Workers Paid). Replacing a table whole
wrote about 2N rows a publish — a 50,000-card collection was the free plan's day in one — so
since 2026-10-25 a publish compares each row's MAC with the one held, deletes the rows whose
`uid` is gone, seals and upserts the rows that are new or changed, and leaves the rest as they
are: **rows written are the rows that changed, plus the table's row** (and the generation
counter's, when anything was sealed). The wire is unchanged. No secondary index is created yet:
each would add a write per changed row.

**What a publish still costs is reading and MACing every row.** `test/measure.test.ts` under Node
on 2026-10-25, on a machine under load — the ingest (inflate, parse, check, MAC, seal what
changed, one transaction), with MAC and sealing also timed alone over the same rows:

| `collection_entries` rows | case          | ingest   | MAC (all rows) | sealing           | rows written                |
| ------------------------- | ------------- | -------- | -------------- | ----------------- | --------------------------- |
| 1,000                     | first publish | 71 ms    | 19 ms          | 40 ms (1,000)     | 1,000 + table + generation  |
| 1,000                     | one row moved | 31 ms    | 19 ms          | 0.2 ms (1)        | 1 + table + generation      |
| 10,000                    | first publish | 639 ms   | 150 ms         | 280 ms (10,000)   | 10,000 + table + generation |
| 10,000                    | one row moved | 294 ms   | 150 ms         | 0.1 ms (1)        | 1 + table + generation      |
| 50,000                    | first publish | 3,718 ms | 1,037 ms       | 1,958 ms (50,000) | 50,000 + table + generation |
| 50,000                    | one row moved | 1,522 ms | 1,037 ms       | 0.1 ms (1)        | 1 + table + generation      |

The documents are 307 KiB, 3,081 KiB and 15,450 KiB of JSON (20, 201 and 1,003 KiB gzipped). An
unchanged republish writes the table's row alone. **Under workerd** (`wrangler dev --local`, the
client's wall clock, the gzip upload included): 50,000 rows took 3,518 ms as a first publish,
1,198 ms with one row moved and 1,026 ms unchanged; 10,000 rows 832, 239 and 205 ms; 1,000 rows
163, 41 and 32 ms. The MAC is WebCrypto's: under workerd it matched `node:crypto`'s synchronous
`createHmac` (~350 ms against ~300–440 ms for 50,000), so no `nodejs_compat` flag was added for
it. ⚠️ **A large table is still past the free plan's CPU allowance per request** (10 ms on Workers
Free): a republish no longer writes 2N rows or seals N, but it parses and MACs N.

## Deploying

⚠️ **No agent may deploy this Worker, apply its migration or set its secrets.** Those are the
owner's, or a release's. `wrangler dev --local` is the only wrangler command an agent may run.

**A release deploys it only when the repository variable `INTEGRATIONS_DEPLOY` is `true`**
(`release.yml`'s `integrations-deploy`, after `scan-deploy`). Unset, the job deploys nothing,
says so in the run's summary, and ends green. Set, it applies this folder's migrations to the
relay's D1 (bookkept in `d1_migrations_integrations`), deploys, and asks the host the probes
below, with the relay's deploy token, `CLOUDFLARE_INFRA_API_TOKEN`.

**What only the owner does, once**, in this order:

1. **Confirm the address.** `wrangler.jsonc`'s route, `integrations.mtg-grimoire.app`, is
   provisional. The app's `integration::store::INTEGRATIONS_BASE` is the placeholder
   `<set on first deploy>` until then, and every build refuses a store request before making it.
   Once the address is decided, it goes into both, byte for byte, in one commit.
2. **Extend the deploy token**: `CLOUDFLARE_INFRA_API_TOKEN` is scoped per Worker and does not
   reach one that does not exist. Add `mtg-grimoire-integrations` to it (_Workers Scripts →
   Edit_), with _Zone → Workers Routes → Edit_ on `mtg-grimoire.app` as the other three have,
   **before** setting `INTEGRATIONS_DEPLOY` — or the first release after is a failed job and a
   draft.
3. **Deploy once by hand**, from this folder, with the pinned tool — the migration first:

   ```
   npm ci --ignore-scripts --prefix ../wrangler
   node ../wrangler/node_modules/wrangler/bin/wrangler.js d1 migrations apply mtg-grimoire-relay --remote
   node ../wrangler/node_modules/wrangler/bin/wrangler.js deploy
   ```

   Read what it prints: the route `integrations.mtg-grimoire.app (custom domain)`, the
   `GroupStore` migration `v1`, and no `workers.dev` address.

4. **Then set the two secrets** — after the deploy, not before: on the share Worker a `secret put`
   against a Worker that did not exist yet did not stick.

   ```
   node ../wrangler/node_modules/wrangler/bin/wrangler.js secret put RELAY_HMAC_KEY
   node ../wrangler/node_modules/wrangler/bin/wrangler.js secret put INTEGRATIONS_KEK
   ```

   `RELAY_HMAC_KEY` is the **same value** the relay, the share Worker and the scan inbox hold.
   `INTEGRATIONS_KEK` is 32 random bytes, base64url, this Worker's alone, and kept somewhere the
   owner can find it — Cloudflare never shows a secret back:

   ```
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
   ```

5. **Then set `INTEGRATIONS_DEPLOY` to `true`** (repository _Settings → Variables_), so releases
   deploy it from then on.

**Ask the host, rather than this file, what it does** — from the repository's root:

```
node scripts/integrations-deploy-probe.ts
```

| Request                                                                        | Answer                                                                                                 |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `GET /g/abc/projection/digests` with no token                                  | `401` — ⚠️ **`500` is `INTEGRATIONS_KEK` unset or not 32 bytes**: the Worker checks it before the door |
| `GET /g/abc/projection/digests` with `authorization: Bearer nonsense`          | `401` — ⚠️ **`500` here alone is `RELAY_HMAC_KEY` unset**                                              |
| `POST /g/abc/settings`                                                         | `405`, `method not allowed`                                                                            |
| `OPTIONS /g/abc/projection/digests` from `https://mtg-grimoire.app`            | `204`, with that origin allowed                                                                        |
| `GET /g/abc/projection/digests` from `https://mtg-grimoire.app`, with no token | `401`, readable by the page                                                                            |
| `OPTIONS /g/abc/projection/digests` from another origin                        | `405`, with no origin allowed                                                                          |
| `GET /`                                                                        | `404`, `not found`                                                                                     |

None of them reaches an object and none holds a token, so two things are shown only by a real
device switching integrations on: that the key is the relay's, and that the objects take a write.

## Testing

No workerd in this tree, for the share Worker's reason. The router is a plain handler over an
injected `Env`, driven as `worker.fetch(request, env)`; the group's object is `src/store.ts`'s
`Store`, a plain class, over `node:sqlite` (`test/fake.ts`) — `src/object.ts` binds it to the
runtime and is the one module no test imports. The relay's D1 is real SQLite too: its
`schema.sql`, with `migrations/` applied over it.

```
pnpm exec vitest run --project integrations-worker
pnpm exec tsc -p infrastructure/integrations-worker/tsconfig.json
MEASURE=1 pnpm exec vitest run --project integrations-worker measure
```

**A consumer's read** is measured too: `GET /c/collection?q=` through the router against a store
of every field on, from the token's claims to the matching rows opened (the figures are in
`docs/reference/integrations-store.md`). A workerd object starting cold adds its own start, which
only Cloudflare can measure.

**The suite is `test/`, beside `src/`**: `src/` is exactly the script a deploy bundles, so
`grep -rn 'group_key\|RELAY_HMAC_KEY' src` finds the relay's key in `gate.ts` alone and no group
key anywhere — `test/wrangler.test.ts` holds that, and the configuration's every binding.
`test/object.test.ts` holds a publish to writing only what changed — an unchanged republish writes
no row and seals nothing, one changed row is sealed alone in a new generation, a missing `uid` is
deleted, rows of two generations open side by side, and a row another publish changed mid-flight
is sealed in another round — reading the rows written off `test/fake.ts`, which counts them as
Cloudflare does. `test/golden.test.ts` ingests the Rust's own documents, `crates/grimoire-core/src/__golden__/
projection.json`, every table under every field on, and refuses each with one key too many.
`test/intents.test.ts` holds the inbox's parsers and the token to plan §3.1 key for key;
`test/inbox.test.ts` the device's side — the pending list, one lease per intent, the ack's rules,
the thirty-day purge, the tokens minted, listed and revoked, the daily cap; and
`test/consumer.test.ts` the integration's — every way a token stops working (a forged MAC, another
group, a re-mint, a revoke, `exp`, `DELETE /g/{group}`, a store made again), a KEK rotation that
does not stop it, every scope refusal, the reads, the 413 and the overlay's three rules.

**Under workerd, on 2026-10-25**, by `wrangler dev --local` over a local D1 built from the relay's
`schema.sql` and `migrations/`: the door (401 to none and to nonsense), `no_store` before
settings, the store made, all six golden tables ingested, a stale watermark refused with the held
one, an equal one taken, a key outside the list refused, the digests, the pre-flight, a lapse pass
(`/__scheduled`) emptying an unentitled group's store and keeping an entitled one's, and `DELETE`;
and `node scripts/integrations-deploy-probe.ts http://127.0.0.1:8799` passed seven of seven.
Nothing of that reached Cloudflare.
