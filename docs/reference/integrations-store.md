# The integrations store — `Projection v1`, the one publisher, and the per-group object

[Issue #1396](https://github.com/Msgaihede/mtg-grimoire/issues/1396), its plan's second and third PRs. The
design is [2026-10-24-integration-data-access-design.md](../superpowers/specs/2026-10-24-integration-data-access-design.md)
(option B); what PR 2 built of it, and the choices it took, are in
[the PR 2 plan](../superpowers/plans/2026-10-25-integrations-projection-store.md), and what PR 3 added
— intents, consumer tokens, the read overlay — in
[the PR 3 plan](../superpowers/plans/2026-10-29-integrations-intents.md) (§8 here). This page is the
record: what each piece is, why it is shaped that way, and every figure with its date.

**The one sentence: the reader's own devices publish a curated, current-state copy of chosen
tables to a per-group object that holds no key of the group's, and nothing in sync changes.** The
store can be read by its consumers (none is wired up yet — Discord is PR 4, remote MCP PR 5) and by
the operator; it cannot write into sync, forge an op, evict a device or publish a share, because it
never holds a relay token, a group key or a device identity. **What a consumer writes is an intent**
(§8): a proposal a device of the group checks against its own allow-list and applies as its own
write, or refuses.

⚠️ **Nothing has been deployed.** The Worker has run under Node in its suite and under `workerd`
locally (`wrangler dev --local`), never on Cloudflare. The app's address for it,
`integration::store::INTEGRATIONS_BASE`, is the placeholder `<set on first deploy>` until the owner
picks the Custom Domain, so every build refuses each store request before making it — and the
Settings panel says the service is not available in this build. **Shares are not behind that
placeholder**: they move onto the publish round in this PR and publish wherever the share Worker
answers today.

---

## 1. The pieces

| Piece | Where | What it is |
| --- | --- | --- |
| The projector | `crates/grimoire-core/src/integration/projection.rs` | `Projection v1`: six table documents under a field policy, a digest each, the golden, the column fence |
| The share snapshot | `crates/grimoire-core/src/share/` | Moved from the desktop host. Its readers are the projector's SQL, scoped to a subtree or a deck and filtered by the share's own rules |
| The store client | `crates/grimoire-core/src/integration/store.rs` | The four device requests, over `platform::http` |
| Settings | `crates/grimoire-core/src/integration/settings.rs` | `IntegrationsStatus`, the local cache, and the four commands |
| The publisher | `crates/grimoire-core/src/integration/publish.rs` | The debounce, the round, and the loop each host spawns beside `live::run` |
| The Worker | `infrastructure/integrations-worker/` | `GroupStore`, one Durable Object per group; device routes; sealing; the lapse cron |
| The panel | `packages/ui/features/settings/IntegrationsPanel.tsx` | Settings → Integrations, the desktop's |

The share viewer — opening a stranger's link inside the app — stayed the desktop's
(`apps/desktop/src-tauri/src/share/publish.rs`); nothing on Android or the web draws one.

## 2. `Projection v1`

One gzipped JSON document per table: `{ v: 1, table, fields, marketplace, currency, rows }`. The six
tables are `collection_folders`, `collection_entries`, `wishlist_folders`, `wishlist_entries`,
`decks`, `deck_cards`; the row keys per table are the plan's §3.1 table, and
`crates/grimoire-core/src/__golden__/projection.json` is every one of them with every field on.

**The fence is absence, not a switch — the share format's rule, kept.** Purchase price, purchase
currency, acquired-at, acquisition source, `needs_review`, serial number, grading, deck
descriptions, deck notes, deck tags, labels and to-dos are not in the format. Condition, language,
market value, entry tags and entry notes are the five opt-ins (`IntegrationFields`), all off by
default, and a row carries an opt-in key only when its field is on *and* it has a value — the
condition sentinel `NONE`, a blank note and an empty tag list are absent rather than empty.

**Locked folders are in**, with `locked` = the folder's effective lock: the store is private, and a
consumer that should skip a drawer the reader set aside can see which ones are.

**Rows are what syncs, and nothing derived.** Every row carries its `sync_uid` as `uid` (so a
later intent and its ack can name a row); a row with none is not projected. The managed wishlist —
the folder each deck's wishlist mode derives on every device, and the wishes filed in it — is left
out by its `managed_deck_id`, because it is a function of the decks, which are projected; the
golden's fixture gives the managed folder a device-local uid to prove the clause does the work.

**Order is by `uid`, never by local id**, so two devices holding the same rows produce the same
document and the same digest (held by a test inserting into two databases in opposite orders).

**The digest** is lowercase hex SHA-256 over `{ fields, marketplace, currency, rows }`. The
document carries no clock, so an unchanged table republished a week later digests the same.

**The column fence**, `every_projected_column_is_classified`: each projected table's head-schema
columns (and `deck_categories`', which the deck cards read) must equal a committed list where every
column is *carried* or *absent* with its reason. A synced column added without classifying it fails
with a sentence that says to classify it and update the golden — the `ipc.test.ts` discipline,
pointed at the projection.

### 2.1 The share snapshot is a filtered projection

Spec §7.5's unification: `share::snapshot` reads through the projector's collection-entry,
wishlist-entry and deck-card readers, scoped to the shared subtree or deck, then applies the share's
own rules — locked folders out, user folders only for a whole-collection share, condition dropped
from wishes and deck cards, the share's three-field policy — and emits `ShareSnapshot v1`.
**`share/__golden__/snapshot.json` and `deck.json` are byte-identical before and after**, and their
tests are the proof. What stayed in the share modules: the deck share's pile list (a share-only
shape; the projection carries the pile on each card instead), and resolving a share key to a folder
or deck with its refusals.

## 3. The publisher

**One trigger for both outputs: the end of a successful sync trip.** `client::round_trip` stamps
`sync_state.last_sync_at` when a trip ends well; the loop each host spawns beside `live::run`
reads it every 15 s and runs a **publish round** once no newer trip has landed for 20 s, or 5 min
after the first unacted trip when trips keep coming, or at once when a Settings press asks for one.
The first trip after launch is always acted on. **There is no diff under `sync_engine/` or
`sync_pair/`**: the stamp the trip already writes is the hook.

**A round** is two halves, and one failing does not stop the other:

1. **Shares** — `share::publish::refresh_live`: the share Worker's list (reconciling the cache),
   then every `live` share whose snapshot digest differs from this device's `share_digest:{id}` is
   republished under its own owner name and fields. **Any syncing device refreshes any live share**,
   which retires two things at once: the desktop-only five-minute timer (`useShareAutoUpdate`,
   `share_auto_update`, issue #1025) and its "only shares this device published" rule. A change made
   on a phone now reaches the link after the phone's next sync with the desktop off. Two devices
   that both refresh after one change upload the same document; the debounce runs after a trip that
   pulled everything, so both read the same rows.
2. **The projection** — when the group's store exists, `GET` its digests, project the six tables
   under **the store's** field policy and the reader's marketplace, and `PUT` each table whose digest
   differs, with this device's `sync_clock` `(ms, ctr)` as the watermark.

**The store's existence is the group's switch** (plan §2): the fields are the group's, so two
devices cannot project under two policies and flap the store between them — and **so is the
marketplace**, which is a per-device setting in the app: prices, and the printing an any-printing
wish is drawn as, are read under the marketplace the store records, set from the device that last
switched the copy on or changed its fields. ⚠️ **Each device used its own until review**, which
made two devices in one group digest every table differently and re-send all six after every
change, each overwriting the other. A share keeps the marketplace it was published under for the
same reason: the round republishes it in the marketplace the share Worker's list carries. `PUT settings` creates
the store; `DELETE` empties it; every device learns both from the digests answer, asking on every
round while it last heard "on" and at most every six hours while it last heard "off". A projection
`PUT` never creates a store, so a device that has not yet heard of a switch-off cannot resurrect
what was deleted.

**A device publishes only what it can read whole** (`integration::readable`). Three rules, each
for a shape review found:

- **No corpus, no round.** A device with no card database does nothing, and a requested publish
  stays owed until cards arrive. ⚠️ **The hole it closes**: a phone or a browser paired before its
  card download finished found every live share stale (it had uploaded none) and republished each
  with card ids for names and no pictures or prices — and the desktop never put it right, since its
  own digest still matched its own last upload. HEAD's "only shares this device published" rule had
  been the guard, without saying so.
- **A missing printing is judged per row.** Each projected row is `Known` (its card is in
  `cards`), `Orphaned` (missing, and the row is no newer than this device's bulk file — a printing
  that has left Scryfall) or `Unseen` (missing, and newer — a card from a set this device has not
  downloaded yet). A share or table with an `Unseen` row is held; one with an `Orphaned` row goes up
  only from a corpus that is current (`bulk_updated_at` within 72 h, `CORPUS_CURRENT_SECS`). A
  device-wide 72 h window alone let yesterday's corpus publish today's preview card by its id.
- **Prices from a feed need the feed.** TCGplayer and Cardmarket prices are in `cards.prices`;
  Card Kingdom's and Mana Pool's are in `marketplace_prices`, which a device downloads only for its
  own selected marketplace (and the web app never for Mana Pool). So a share or table that reads
  prices — `value` on, or any wishlist, since an any-printing wish is drawn as its cheapest printing
  — at a feed marketplace is held unless this device's feed for it was fetched within 72 h
  (`FEED_CURRENT_SECS`, `marketplace_feed_meta.fetched_at`). Having the rows is not enough: a device
  that switched away keeps them for ever.

Held is silent — no request, no row — because another device of the group can publish it.

**The round holds the sync lane**, as `share_auto_update` did, and every request in it is bounded;
trips queue behind it. The snapshots and the projection are read on the read connection where the
host has one, in one read transaction, and a one-thread host is handed back its turn between
shares and between tables.

## 4. The Worker

`mtg-grimoire-integrations`, the fourth Worker beside the relay, the share Worker and the scan
inbox, for the share Worker's reason: a bad deploy here must not be a sync outage. Its README has
the routes, the codes and the deploy runbook; what matters here:

- **The gate is the share Worker's**: a relay token verified under `RELAY_HMAC_KEY`, its group equal
  to the path's, `stillInGroup` against the newest `group_keys` manifest. Nothing else reaches the
  object. `src/` holds `RELAY_HMAC_KEY` in token verification alone and no group key at all; a test
  holds that, and that no binding names the relay's Durable Object namespace.
- **It holds the device to the format**: a document whose `fields` or `marketplace` differ from
  the store's is `409 settings_mismatch`; a row key outside its table's list for those fields is `400 bad_projection`;
  an older watermark than the table's is `409 stale_projection` (equal is accepted — a republish
  after a price or corpus change moves no clock). The suite ingests the Rust golden, and refuses it
  with one extra key in any table.
- **At rest: a sealed payload and a clear index** (issue knob 2). Clear columns are only what later
  queries need — `uid`, Scryfall id, normalised name, set, collector number, finish, quantity, the
  row's container (an entry's folder, a folder's parent, a deck card's deck) and kind. The whole row
  is sealed with AES-256-GCM under an HKDF subkey of a random per-group data key; the data key is
  stored wrapped under `INTEGRATIONS_KEK`, so the KEK rotates by rewrapping (README). **AES-GCM and
  not XChaCha20-Poly1305**: the Worker-side sealing the issue said to lift is WebCrypto AES-GCM with
  HKDF, and WebCrypto has no XChaCha; a subkey per table generation keeps every key far below
  AES-GCM's random-nonce bound.
- **A change of fields or marketplace drops every table**, so narrowing the policy removes the
  data under the old one from the server before any device republishes. A change of fields from
  Settings sends `create: false`, so it cannot re-make a store another device has just deleted.
- **The lapse cron** deletes the stores of groups whose membership no longer serves (the share
  Worker's `SERVING_GROUPS` rule), at most 25 a pass, from the `integration_groups` table in the
  relay's D1 under this Worker's own migrations table.

## 5. Measurements

### 5.1 Publish size and time (device side)

`collection_entries` alone, release build, this Windows PC, 2026-10-25, the time to project, digest
and gzip (`projection::tests::a_whole_collection_projection_is_measured`, `--ignored`):

| Rows | Fields | Raw | Gzipped | Raw / card | Gzipped / card | Time |
| --- | --- | --- | --- | --- | --- | --- |
| 1 000 | off | 348 551 B | 61 758 B | 348.6 B | 61.8 B | 10.5 ms |
| 1 000 | all five | 391 442 B | 66 183 B | 391.4 B | 66.2 B | 12.9 ms |
| 10 000 | off | 3 504 552 B | 620 580 B | 350.5 B | 62.1 B | 100.6 ms |
| 10 000 | all five | 3 933 093 B | 667 799 B | 393.3 B | 66.8 B | 137.8 ms |
| 50 000 | off | 17 611 217 B | 3 096 805 B | 352.2 B | 61.9 B | 635.0 ms |
| 50 000 | all five | 19 753 758 B | 3 312 707 B | 395.1 B | 66.3 B | 756.2 ms |

**Larger than a share's 273 B / 41.3 B a card** (share §3.1), by the readable keys and the `uid` on
every row a share does not carry. A 50 000-card table is 3.3 MB gzipped, under the 8 MiB cap with
room to spare; the upload time is the reader's uplink's, and was not measured.

### 5.2 Store ingest (Worker side)

**A publish is a diff inside the object**, not a replacement. The device still sends the whole
table (its digest differed from the store's); the store keeps, per row, the generation it was
sealed in and an HMAC-SHA-256 of the row's canonical JSON under a key HKDF derives from the group's
data key — keyed, so a storage dump cannot confirm guesses about the sealed fields from the clear
ones. A row whose uid is gone is deleted, an unchanged row is not touched, and only new or changed
rows are sealed and written. ⚠️ **Until the measurement below it replaced the whole table**, which
wrote ~2N rows a publish (deletes count): a 50 000-row collection spent Workers Free's 100 000 rows
a day — or a few hundred publishes' worth of a paid account's included 50 M a month — every time
one card moved.

`collection_entries`, Node 24, this Windows PC under load, 2026-10-25 (`MEASURE=1`,
`infrastructure/integrations-worker/test/measure.test.ts`); ingest is inflate, parse, check, MAC,
seal and one transaction:

| Rows | Case | Ingest | MAC (every row) | Sealing | Rows written |
| --- | --- | --- | --- | --- | --- |
| 1 000 | first publish | 71 ms | 19 ms | 40 ms | 1 002 |
| 1 000 | one row changed | 31 ms | 19 ms | 0.2 ms | 3 |
| 10 000 | first publish | 639 ms | 150 ms | 280 ms | 10 002 |
| 10 000 | one row changed | 294 ms | 150 ms | 0.1 ms | 3 |
| 50 000 | first publish | 3 718 ms | 1 037 ms | 1 958 ms | 50 002 |
| 50 000 | one row changed | 1 522 ms | 1 037 ms | 0.1 ms | 3 |

The same, under `workerd` (`wrangler dev --local`, the client's wall clock, gzip upload included):

| Rows | First publish | One row changed | Unchanged |
| --- | --- | --- | --- |
| 1 000 | 163 ms | 41 ms | 32 ms |
| 10 000 | 832 ms | 239 ms | 205 ms |
| 50 000 | 3 518 ms | 1 198 ms | 1 026 ms |

**WebCrypto for the MAC, and not a library**: synchronous `node:crypto` HMAC was three times faster
under Node (its WebCrypto runs on a thread pool) and no faster under `workerd`, where it would also
need `nodejs_compat`. The first ingest's fixture documents are 307 KiB, 3 081 KiB and 15 450 KiB of
JSON — smaller than the device's own figures in 5.1, whose rows are fuller; it is the row count that
the costs follow.

### 5.3 What this PR could not measure

- **The cold answer time against Discord's three seconds** needs a consumer route, which is PR 3.
- **Anything on Cloudflare**: the deployed ingest time, the cold start of a `GroupStore`, the
  request and row-write figures — all after the owner's first deploy.

## 6. Costs and limits the owner should know before deploying

- **CPU**: a republish still inflates, parses and MACs every row of the table it changed, so a
  50 000-row table is over a second of CPU even when one card moved, and its first publish several
  (5.2) — far past Workers Free's 10 ms a request. The store needs the Workers Paid plan (30 s a
  request by default) for any collection past a few hundred cards. The device sends a table only
  when its digest differs from the store's, so an unchanged table costs one digests read and no
  ingest at all.
- **Rows written** are billed per row on Durable Objects' SQLite storage (deletes count): a first
  publish writes the table's rows, after which a publish writes what changed plus two (5.2).
- **Rows read**: each ingest reads every held `(uid, mac)` pair once, twice when anything changed
  (Workers Free: 5 M a day).
- **Memory**: an isolate has 128 MB. A document may inflate to **24 MiB** (`413 projection_limit`
  past it), decoded as it arrives so the store holds one copy of the text: the largest measured
  table, 50 000 cards with every field on, is ~19.8 MB of the device's JSON (5.1), and a cap much
  past 24 MiB lets inflating and parsing reset the isolate before it can answer. ⚠️ **It was
  64 MiB, kept as chunks and then joined**, until a review measured 60 MiB of gzipped spaces —
  61 KB on the wire — reaching 128 MiB of buffers before the parse: any member could reset their
  group's object. A collection past ~60 000 cards needs row deltas, which spec §6.1 already names.
- **The release job is gated** on the repository variable `INTEGRATIONS_DEPLOY == 'true'`, and
  `CLOUDFLARE_INFRA_API_TOKEN` must be extended to the new Worker before it is set; until then a
  release deploys the other four and says this one was skipped.

## 7. Deploying it, in order (the owner's steps)

1. Pick the Custom Domain (provisional: `integrations.mtg-grimoire.app`, in `wrangler.jsonc`).
2. Extend `CLOUDFLARE_INFRA_API_TOKEN` to `mtg-grimoire-integrations`, or deploy by hand.
3. Deploy, then `wrangler secret put RELAY_HMAC_KEY` (the relay's value) and `INTEGRATIONS_KEK`
   (32 random bytes, base64url) — a secret put before the Worker exists does not stick. The README's
   probe tells a missing key (500) from a set one (401).
4. In the app: set `INTEGRATIONS_BASE` to the address, add it to the web host's `connect-src` and
   to the privacy page's host table (both are held by tests), and ship a release.
5. Set `INTEGRATIONS_DEPLOY` to `true` so later releases deploy it with the others.
