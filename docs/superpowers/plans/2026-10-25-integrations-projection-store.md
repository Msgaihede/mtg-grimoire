# Integrations, PR 2 — `Projection v1`, the one publisher, and the store (read-only)

**Status: built on `claude/integration-projection-intent-inbox-d6f60d`, 2026-10-25.** Issue
[#1396](https://github.com/Msgaihede/mtg-grimoire/issues/1396), its plan's second PR. The design is
[`2026-10-24-integration-data-access-design.md`](../specs/2026-10-24-integration-data-access-design.md)
(option B, §6, §7.5); this file is what PR 2 builds of it, the contracts between its pieces, and the
choices the spec left open. Nothing consumes the store yet: intents are PR 3
([its plan](2026-10-29-integrations-intents.md)), Discord PR 4.

## 1. What this PR ships

1. **`grimoire_core::integration::projection`** — `Projection v1`: six table documents, a field
   policy (`IntegrationFields`), a digest per table, a committed golden, and a column fence that
   fails when a projected table grows a column nobody classified.
2. **`grimoire_core::share`** — the share snapshot, its deck and wishlist readers, the
   `collection_shares` cache and the publish/refresh/revoke/list requests, **moved out of the
   desktop host** so Android and the web host refresh shares too. The snapshot readers are re-based
   on the projector's SQL; `share/__golden__/snapshot.json` and `deck.json` stay byte-identical.
   The viewer (`share_open`, a stranger's link) stays the desktop's.
3. **`grimoire_core::integration::publish`** — one publish round after a successful sync trip,
   debounced: refresh every live share of the group whose snapshot changed (any device, not only
   the one that published it), and, when the group's store exists, send the projection tables whose
   digest differs from the store's. A host-spawned loop beside `sync_engine::live::run` on all
   three hosts. **No diff under `sync_engine/` or `sync_pair/`**: the loop reads the trip's own
   `last_sync_at` stamp.
4. **`infrastructure/integrations-worker/`** — the fourth Worker: a `GroupStore` Durable Object per
   group (SQLite storage), device routes behind relay tokens, payloads sealed under a per-group data
   key wrapped by `INTEGRATIONS_KEK`, `deleteAll`, a lapse cron. CI job, path router, and a gated
   `integrations-deploy` job in `release.yml`.
5. **Settings → Integrations** (desktop) — the master switch with the spec's privacy sentence and
   the five field opt-ins, default off.
6. **The five-minute share timer is retired**: `useShareAutoUpdate.ts` and `share_auto_update`
   go; the publish round replaces them.
7. **`docs/reference/integrations-store.md`** — the store, the format, the publisher, the deploy
   steps, and the measurements this PR can take.

## 2. Decisions this PR takes (each overridable on the issue)

- **The store's existence is the group's switch.** Field opt-ins are the group's, not a device's:
  two devices projecting under two policies would flap the store between them. **So is the
  marketplace** the prices (and an any-printing wish's drawn printing) are read under — a
  per-device setting in the app, so the store records the one the reader's device had when they
  last switched on or changed the fields. So `PUT /g/{group}/settings` creates the store and
  records the fields and the marketplace; `DELETE /g/{group}` empties it;
  every device learns both from `GET …/projection/digests` (a 404 `no_store` is "off"). A device
  that last heard "off" asks again at most every six hours; one that last heard "on" asks on every
  publish round. A projection `PUT` never creates a store, so a device that has not heard of a
  switch-off cannot resurrect what was deleted.
- **Changing the fields or the marketplace drops every projected table at once**, so narrowing the
  policy (notes off) removes the notes from the server before any device republishes.
- **A share keeps the marketplace it was published under**: the publish round republishes a share
  in the marketplace the share Worker's list says, never in the refreshing device's own.
- **A device publishes only what it can read whole** (`integration::readable`). With no corpus
  the round does nothing; a row whose printing is missing and newer than this device's bulk file
  holds its share or table; a genuine orphan goes up only from a current corpus (72 h); and prices
  read at Card Kingdom or Mana Pool need this device's feed for it fetched within 72 h — otherwise a
  phone paired before its card download would republish names as ids, or strip a share's prices.
- **The Worker refuses a document whose `fields` or `marketplace` differ from the store's** (`409
  settings_mismatch`) and any row key outside its table's list for those fields (`400
  bad_projection`) — the device filters, and the Worker holds it to it.
- **Sealing is AES-256-GCM, not XChaCha20-Poly1305.** The branch's Worker-side sealing that the
  issue says to lift (`bot-device/src/proposals.ts`) is WebCrypto AES-GCM with HKDF, and WebCrypto
  has no XChaCha. Envelope encryption as the issue specifies: a random 32-byte data key per group,
  stored wrapped (AES-GCM, AAD = group id) under `INTEGRATIONS_KEK`, rewrappable for rotation. Each
  row is sealed under an HKDF subkey of the data key per `(table, generation)` — a new generation on
  every table replacement — so no key ever sees more than one table's worth of random 96-bit nonces.
- **The store's address is a placeholder until the owner picks the Custom Domain.**
  `integration::store::INTEGRATIONS_BASE` is `<set on first deploy>`, `share::publish::SHARE_BASE`'s
  own history: every store request is refused before it is made with `NOT_DEPLOYED`, and the panel
  says the service is not available in this build. `integrations_url` in `sync_state` overrides it
  for `wrangler dev` and tests. Shares are unaffected — they publish today.
- **`release.yml`'s deploy job is gated on the repository variable `INTEGRATIONS_DEPLOY == 'true'`**
  and skips green otherwise, saying so in the summary. `CLOUDFLARE_INFRA_API_TOKEN` is scoped per
  Worker and does not cover a Worker that does not exist yet; an ungated job would fail the first
  release after this merges and leave it a draft.
- **The web host refreshes shares too**, which needs the share Worker to answer the web app's origin
  (CORS, `scan-worker/src/cors.ts`'s three functions) and `connect-src` to name it. Same Worker,
  same routes, same R2 blobs, same `ShareSnapshot v1`.
- **The Settings panel is the desktop's**, as the Share control is (`edition.publishes`). The light
  hosts publish in the background whenever the group's store exists.
- **The publish round holds the sync lane**, as `share_auto_update` did, and every request in it is
  bounded. Trips queue behind it; nothing is refused.

## 3. The contracts

### 3.1 `Projection v1` (Rust → integrations Worker)

One gzipped JSON document per table:

```json
{
  "v": 1,
  "table": "collection_entries",
  "fields": ["condition", "lang"],
  "marketplace": "tcgplayer",
  "currency": "USD",
  "rows": [ { "uid": "…", "scryfallId": "…", "name": "…", "set": "mh3", "cn": "12", "finish": "nonfoil", "quantity": 1, "folderUid": null, "image": "https://cards.scryfall.io/…", "condition": "NM", "lang": "en" } ]
}
```

`fields` is the subset of `condition`, `lang`, `value`, `tags`, `notes` the group switched on, in
that order. A row carries an opt-in key **only** when its field is on, and omits it when the value is
absent (no `null` for an opt-in). Every row carries a non-empty `uid` (its `sync_uid`); rows with no
`sync_uid` — the managed wishlist's derived folders and wishes — are not projected (they are a
function of the decks, which are).

| Table | Row keys (always) | Opt-in keys it can carry |
| --- | --- | --- |
| `collection_folders` | `uid`, `name`, `parentUid`, `kind`, `locked` | — |
| `collection_entries` | `uid`, `scryfallId`, `name`, `set`, `cn`, `finish`, `quantity`, `folderUid`, `image`? | `condition`, `lang`, `value`, `tags`, `notes` |
| `wishlist_folders` | `uid`, `name`, `parentUid` | — |
| `wishlist_entries` | `uid`, `scryfallId`, `oracleId`, `name`, `set`, `cn`, `finish`, `quantity`, `folderUid`, `image`? | `lang`, `value`, `tags`, `notes` |
| `decks` | `uid`, `name`, `format`, `folderUid`, `cover`? | — |
| `deck_cards` | `uid`, `deckUid`, `pile`, `kind`, `active`, `scryfallId`, `name`, `set`, `cn`, `finish`, `quantity`, `image`?, `typeLine`?, `manaCost`?, `manaValue`? | `lang`, `value` |

`?` = omitted when absent. `null` is allowed for `parentUid`, `folderUid`, `scryfallId` (an
any-printing wish), `oracleId`. `kind` is `collection_folders.kind` on folders and the pile's
`deck_categories.kind` on deck cards. `cover` is `{ "img", "artist" }` (share `ShareCover`).
`tags` is the entry's free-text `tags` column (the collection's, and the wishlist's since user
schema v67, issue #1398) as an array of strings; `notes` is the entry
note. **Absent from the format, never a switch**: purchase price, purchase currency, acquired-at,
acquisition source, `needs_review`, serial number, grading, deck descriptions, deck notes, deck
tags, labels, to-dos. The golden is `crates/grimoire-core/src/__golden__/projection.json` (an
object keyed by table, every field on); the Worker's suite ingests it.

**Digest**: lowercase hex SHA-256 of the document's JSON with `rows`, `fields`, `marketplace` and
`currency` (no clock in the document at all). Opaque to the Worker, which stores and returns it.

### 3.2 Device routes (integrations Worker)

Bearer = a relay token (`entitlement::access_token`), verified with `RELAY_HMAC_KEY`;
`claims.grp` must equal the path group; `stillInGroup` against the newest `group_keys` row — the
share Worker's `authorised`, copied. Errors are `{ "error": "<sentence>", "code": "<code>" }`.

| Route | Body | Answers |
| --- | --- | --- |
| `GET /g/{group}/projection/digests` | — | 200 `{ "fields": IntegrationFields, "marketplace", "tables": { "<table>": { "digest", "hlcMs", "hlcCtr", "rows", "publishedAt" } } }` (`publishedAt` in ms); 404 `no_store` |
| `PUT /g/{group}/settings` | `{ "fields": IntegrationFields, "marketplace": "tcgplayer" \| "cardmarket" \| "cardkingdom" \| "manapool", "create": bool }` | 200 `{ "fields", "marketplace", "created": bool }` — `create: true` (the switch) makes the store if absent; `create: false` (a change of fields) answers 404 `no_store` instead; a change of fields or marketplace drops every table; 400 `bad_settings` |
| `PUT /g/{group}/projection/{table}` | the gzipped document, `content-type: application/gzip`; headers `x-projection-hlc-ms`, `x-projection-hlc-ctr`, `x-projection-digest` | 200 `{ "table", "digest", "rows", "hlcMs", "hlcCtr" }`; 404 `no_store`; 409 `stale_projection` (an older watermark than the table's) with the held `hlcMs`/`hlcCtr`; 409 `settings_mismatch` with the store's `fields` and `marketplace`; 413 `projection_limit` (8 MiB gzipped, 24 MiB inflated); 400 `bad_projection` |
| `DELETE /g/{group}` | — | 204, whether or not there was a store |

`IntegrationFields` on the wire: `{ "condition": bool, "lang": bool, "value": bool, "tags": bool,
"notes": bool }`. The watermark is the publisher's `sync_clock` `(ms, ctr)`; equal is accepted
(a republish after a price or corpus change moves no clock). `OPTIONS` answers the web app's
origin (`APP_ORIGINS`), allowing `authorization`, `content-type` and the three `x-projection-*`
headers.

### 3.3 IPC (Rust ↔ page)

```rust
// crates/grimoire-core/src/integration/projection.rs
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationFields { pub condition: bool, pub lang: bool, pub value: bool, pub tags: bool, pub notes: bool }

// crates/grimoire-core/src/integration/settings.rs
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationsStatus {
    pub available: bool,          // this build has a store address (or an override)
    pub entitled: bool,           // a device in a group with a membership (`sync_engine::commands::entitled`)
    pub enabled: bool,            // the group's store exists, as last heard
    pub fields: IntegrationFields,
    pub checked_at: Option<i64>,  // unix seconds the store was last asked
    pub published_at: Option<i64>,// unix seconds this device last published a table to it
    pub error: Option<String>,    // the last publish round's failure, in a sentence, or None
}
```

Commands (core `TABLE` as `task` entries, desktop wrappers, `ipc.ts` camelCase):
`integrations_status()`, `integrations_enable(fields)`, `integrations_set_fields(fields)`,
`integrations_disable()` — each answers an `IntegrationsStatus`. `integrations_status` asks the store
when it can and answers the cache when it cannot.

## 4. The publisher

- **Trigger**: `sync_state.last_sync_at`, which `client::round_trip` stamps at the end of every
  successful trip. The loop polls it every 15 s (one local read). A trip it has not acted on makes
  a round due once no newer trip has landed for **20 s**, or **5 min** after the first unacted trip
  if trips keep coming (a long editing session). A pure decision function, tested with explicit
  clocks; the first trip after launch is always acted on.
- **A round**: (1) shares — `GET /g/{group}/shares` (reconciling the cache), then every `live`
  share whose snapshot digest differs from this device's `share_digest:{id}` is republished under
  its own owner name and fields; (2) projection — when the group's store exists, `GET` the digests,
  project the six tables under the store's fields, `PUT` each whose digest differs. Each half's
  failure is an `error_log` row and does not stop the other.
- **On every host**: desktop (`desktop.rs`), Android (`apps/light/src-tauri/src/lib.rs`), web
  (`crates/grimoire-web/src/host.rs`), spawned beside `live::run`.

## 5. Fences

- `share/__golden__/snapshot.json` and `deck.json` byte-identical (unchanged files, same tests).
- `__golden__/projection.json` + `projection::tests::every_projected_column_is_classified` (a
  column of a projected table that is neither carried nor named absent fails).
- The Worker ingests the golden and refuses a row key outside its table's list.
- `wrangler.test.ts`: no Durable Object binding but its own `GroupStore`, no `workers_dev`, no
  relay namespace; `grep` for `group_key` finds nothing in `src/`, and `RELAY_HMAC_KEY` appears only
  in token verification.
- `ipc.test.ts` parity for `IntegrationFields` and `IntegrationsStatus`.
- `infrastructure/app-worker`'s `connect-src` census learns `SHARE_BASE` (and stays silent on the
  placeholder `INTEGRATIONS_BASE`).
