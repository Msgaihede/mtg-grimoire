# Integrations, PR 3 — intents: the inbox, consumer tokens, the overlay and the device's applier

**Status: built on `claude/pensive-allen-1qo1np`, 2026-10-29.** Issue
[#1396](https://github.com/Msgaihede/mtg-grimoire/issues/1396), its plan's third PR. The design is
[`2026-10-24-integration-data-access-design.md`](../specs/2026-10-24-integration-data-access-design.md)
(option B, §6.2, §6.3); PR 2 built the store this writes into
([the PR 2 plan](2026-10-25-integrations-projection-store.md),
[integrations-store.md](../../reference/integrations-store.md)). Nothing outside the suites mints a
consumer token yet: Discord is PR 4, remote MCP PR 5.

## 1. What this PR ships

1. **The inbox** — `GroupStore` keeps intents beside the projection: typed, schema-checked
   proposals an integration writes and a device of the group validates, applies as its own write,
   and acks. Sealed at rest like the rows.
2. **Consumer tokens** — the store mints `{ grp, int, scp, exp, tid }` tokens for an integration on
   a device's request, signed under a key drawn from the group's data key; revoked one at a time on
   request, and all at once by `deleteAll`.
3. **Consumer routes** — `/c/…`: the collection, the wishlist, decks, folders and autocomplete read
   from the sealed projection **overlaid by the intents no published table reflects yet**, and
   `POST /c/intents` with its `429` and `413`.
4. **`grimoire_core::integration::intents`** — the wire types, the device's own allow-list (checked
   again on apply whatever the Worker let through), the applier over `collection::add_entry` and
   `wishlist::add_wish`, the per-kind policy, and the round's intents half.
5. **The publish round's intents half**, on all three hosts, plus an intents-only check every five
   minutes while the store is on, so an idle open device applies a Discord add without waiting for
   an edit.
6. **Settings → Integrations → review**: the parked intents with Apply and Decline, and the
   per-source, per-kind *apply automatically* switches.
7. **Docs**: this file, `integrations-store.md` §§ on intents, the Worker's README, the cold answer
   time measured as far as Node can measure it.

## 2. Decisions this PR takes (each overridable on the issue)

- **A claim before an apply.** The issue's inbox is `GET` and `ack`; two devices that both `GET` a
  pending intent and both apply it before either acks would add the card twice — an add is a
  quantity, not an idempotent put. So a device **claims** an intent (`POST …/claim`, a ten-minute
  lease) before it applies, applies only what it holds a lease on, and acks with the lease. A
  refusal needs no claim: every device refuses the same intent for the same reason.
- **An ack owed survives a crash.** The apply and a row naming the ack it owes are one savepoint
  (`app_meta` `integrations_owed_acks`); the next intents half sends owed acks before anything else.
- **The overlay keeps an applied intent until a published table reflects it**, not until its ack:
  the ack carries the applying device's `sync_clock` after the write, and an applied intent stays in
  the overlay while its table's held watermark is older. Dropping it at the ack would leave a gap
  where the card is in neither the overlay nor the projection — the round acks before its own
  projection half publishes, and a device that cannot publish the table (`readable`) leaves it to
  another.
- **The token key is drawn from the group's data key** (HKDF, an info string of its own), not from
  `INTEGRATIONS_KEK`: a KEK rotation rewraps the data key and moves no token, and `deleteAll` takes
  the data key — and with it every token's key — away. The issue's "HMAC under a key the Worker
  owns", held per group. The router reads the token's group to route; the object verifies it.
- **The policy is the device's** (`app_meta` `integrations_automatic`, never synced, never the
  store's): a compromised store must not be able to flip what a device applies unasked. Discord's
  `collection.add` and `wishlist.add` are automatic and fixed (the reader pressed Confirm in Discord);
  every other `(source, kind)` parks until the reader switches it on, on that device. A parked intent
  stays pending in the store — any device whose policy applies it, or a press in the review list,
  takes it.
- **Folders are required where the allow-list requires them**: a collection add names a
  `kind = 'user'` collection folder by its `sync_uid` (never the root, the branch's §14.2 rule); a
  wishlist add names a wishlist folder that no deck manages, or `null` for the wishlist's root.
- **Display hints ride with the payload and are never trusted**: `name`, `set`, `cn` let the overlay
  draw and search an add before any device has seen it. The device reads the card from its own card
  data and ignores them.
- **A card this device does not know waits, unless its card data is current**: then it is refused
  (`readable::CORPUS_CURRENT_SECS`'s rule, applied to an intent). A folder this device does not hold
  is refused — the half runs after a trip that pulled everything.
- **Consumer tokens get no command or panel row in this PR.** The core can mint, list and revoke
  (`store::mint_consumer`, `consumers`, `revoke_consumer`); PR 4 wires Discord's and PR 5 remote
  MCP's into Settings. `DELETE /g/{group}` revokes every token by taking the key.
- **Intents are kept 30 days after their ack**, then purged on the next write to the inbox. A
  pending intent is kept until it is acked or the store is deleted; the daily cap bounds them.

## 3. The contracts

### 3.1 An intent (Worker ↔ device ↔ consumer)

```json
{ "id": "<22 chars base64url, 16 random bytes>", "group": "<group>",
  "source": "discord" | "mcp" | "trade",
  "kind": "collection.add" | "wishlist.add",
  "payload": { … },
  "createdAt": 1793000000000, "confirmedBy": "discord:123" | null,
  "state": "pending" | "applied" | "refused", "reason": null | "<sentence>" }
```

`createdAt` is Unix **milliseconds** (the Worker's clock). `source` is the token's integration; v1
mints tokens for `discord` and `mcp` only (`trade` is PR 6's, written by a room object).

**Payloads — exact key sets, nothing else** (the Worker refuses any other key, and so does the
device):

| `kind` | Required | Optional (display hints, ≤ 200 chars each) |
| --- | --- | --- |
| `collection.add` | `scryfallId` (string, 1–64), `finish` (`nonfoil` \| `foil` \| `etched`), `quantity` (integer 1–99), `folderUid` (string, 1–64) | `name`, `set`, `cn` |
| `wishlist.add` | `scryfallId` (string 1–64 or `null`), `oracleId` (string 1–64 or `null`) — not both `null`, `finish` (one of the three or `null`), `quantity` (integer 1–99), `folderUid` (string 1–64 or `null` = the root), `name` (string 1–200) | `set`, `cn` |

`confirmedBy` is a string of 1–128 characters or `null`. A `POST /c/intents` body is
`{ "kind", "payload", "confirmedBy" }`, exactly those keys.

### 3.2 Device routes (new; bearer = relay token, the existing door)

| Route | Body | Answers |
| --- | --- | --- |
| `GET /g/{group}/intents?since=<ms>` | — | 200 `{ "intents": Intent[], "more": bool }` — pending only, oldest first, at most 200, `createdAt > since` when given; 404 `no_store` |
| `POST /g/{group}/intents/{id}/claim` | — | 200 `{ "id", "lease", "leaseUntil" }` (lease: 22 chars base64url; `leaseUntil` ms, now + 10 min); 409 `claimed` (another live lease); 409 `already_acked` with `state`; 404 `no_intent`; 404 `no_store` |
| `POST /g/{group}/intents/{id}/ack` | `{ "state": "applied" \| "refused", "reason": string \| null, "lease": string \| null, "hlcMs": int \| null, "hlcCtr": int \| null }` | 200 `{ "id", "state" }` — `applied` needs the intent's lease and a watermark; `refused` needs a reason (1–300 chars) and is refused only by another live lease; an ack repeating the held state is 200; 409 `claimed`; 409 `already_acked` with `state`; 400 `bad_ack`; 404 `no_intent`; 404 `no_store` |
| `POST /g/{group}/consumers/{integration}` | `{ "scopes": Scope[], "days": 1–365 }` | 200 `{ "integration", "token", "scopes", "exp" }` (`exp` Unix seconds) — replaces any token that integration held; 400 `bad_consumer`; 404 `no_store` |
| `GET /g/{group}/consumers` | — | 200 `{ "consumers": [{ "integration", "scopes", "issuedAt", "exp" }] }` (`issuedAt` ms); 404 `no_store` |
| `DELETE /g/{group}/consumers/{integration}` | — | 204, whether or not it held one |

`{id}` is `[A-Za-z0-9_-]{22}`; `{integration}` is `discord` or `mcp`. Scopes: `collection:read`,
`wishlist:read`, `decks:read`, `collection:add`, `wishlist:add` — a non-empty set, no repeats.

### 3.3 Consumer routes (bearer = a consumer token)

Token: `gct1.<base64url(claims JSON)>.<base64url(HMAC-SHA-256)>`, claims
`{ "grp", "int", "scp": Scope[], "exp": <unix s>, "tid": "<22 chars>" }`, the MAC over the ASCII of
`gct1.<claims>` under HKDF(data key, salt `mtg-grimoire/integrations/consumer/v1`, info
`consumer-token`). Live when the MAC holds, `exp` is in the future, and the store's row for `int`
holds `tid`. Anything else is 401 `unauthorized`, with no word on which part failed.

| Route | Scope | Answers |
| --- | --- | --- |
| `GET /c/collection?q=&folder=` | `collection:read` | 200 `{ "rows": Row[], "more": bool, "publishedAt": ms \| null, "fields": IntegrationFields, "marketplace" }` — projection rows of `collection_entries` whose normalised name contains `q` (all when absent), in `folder` (a folder uid) when given, by name then uid, at most 50; then the overlay |
| `GET /c/wishlist?q=&folder=` | `wishlist:read` | the same over `wishlist_entries` |
| `GET /c/decks?q=` | `decks:read` | 200 `{ "decks": Row[], "more" }`, at most 200 |
| `GET /c/decks/{uid}` | `decks:read` | 200 `{ "deck": Row, "cards": Row[] }`; 404 `no_deck` |
| `GET /c/folders` | `collection:read` or `wishlist:read` | 200 `{ "collection"?: Row[], "wishlist"?: Row[] }` — each list only under its read scope |
| `GET /c/autocomplete?kind=collection\|wishlist\|decks\|folders&q=` | the kind's read scope (`folders`: `collection:read`) | 200 `{ "choices": [{ "name", "value" }] }`, at most 25: distinct card names (value = name), deck names (value = uid), `kind = 'user'` collection folder names (value = uid) |
| `POST /c/intents` | `collection:add` / `wishlist:add` by kind | 200 `{ "intent": Intent }`; 400 `bad_intent`; 403 `scope`; 413 `intent_too_large` (64 KiB); 429 `intent_quota` (64 a UTC day per integration) |
| `GET /c/intents/{id}` | any | 200 `{ "intent": Intent }` — that integration's own intents only; 404 `no_intent` |

**The overlay**: an intent of the read's kind (`collection.add` for the collection, `wishlist.add`
for the wishlist) that is `pending`, or `applied` with an ack watermark newer than the table's held
one (or a table never published), and matches the read's `q` (by its `name` hint, normalised) and
`folder`, is appended after the projection rows as
`{ "uid": null, "intentId", "state", "scryfallId", "oracleId"?, "name", "set"?, "cn"?, "finish", "quantity", "folderUid" }`.
A refused intent is never overlaid.

`/c/*` answers no `Origin`: consumers are servers. `q` is at most 100 characters.

### 3.4 At rest

`intents(id PK, source, kind, state, created_at, acked_at, lease, lease_until, ack_hlc_ms,
ack_hlc_ctr, reason, name_norm, folder_uid, sealed)` — `sealed` is AES-256-GCM of
`{ payload, confirmedBy }` under HKDF(data key, salt `mtg-grimoire/integrations/intent/v1`, info
`intents`), AAD `intent \0 id`. `consumers(integration PK, tid, scopes, issued_at, exp)`,
`intent_days(integration, day, count, PK(integration, day))`. Everything the clear columns hold is
what the overlay and the caps query.

### 3.5 IPC (Rust ↔ page)

```rust
// crates/grimoire-core/src/integration/review.rs
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntentReview { pub intents: Vec<ParkedIntent>, pub automatic: Vec<IntentAutomatic> }

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParkedIntent {
    pub id: String,
    pub source: String,             // "discord" | "mcp" | "trade"
    pub kind: String,               // "collection.add" | "wishlist.add"
    pub name: String,               // this device's name for the card, else the hint, else the id
    pub set: Option<String>,
    pub cn: Option<String>,
    pub finish: Option<String>,
    pub quantity: i64,
    pub folder: Option<String>,     // the folder's name here; None = the wishlist's root
    pub created_at: i64,            // Unix ms
    pub confirmed_by: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntentAutomatic { pub source: String, pub kind: String, pub on: bool, pub fixed: bool }
```

Commands (core `TABLE` `task` entries, desktop wrappers, `ipc.ts`), each answering an
`IntentReview`:

- `integrations_review()` — the parked intents (pending, and this device's policy parks them) and the
  four automatic rows (`discord`×2 `on: true, fixed: true`; `mcp`×2 from the policy). **No request
  and an empty list** when the store cannot be asked (no address, no membership, cache off); a failed
  request is `Err(sentence)`.
- `integrations_review_apply(id)` — claim, check, apply, ack, as the round does, for one intent
  whatever the policy says. A refusal by the allow-list acks refused and answers `Err(reason)`.
- `integrations_review_decline(id)` — ack refused with `DECLINED` ("Declined in the app.").
- `integrations_set_automatic(source, kind, on)` — the policy; `fixed` rows refuse. Turning one on
  asks for a publish round, so parked intents of that kind are applied within one poll.

The page toasts an apply (the owner's rule: every deliberate add toasts).

## 4. The device's half

- **In the publish round, between shares and the projection**, when the store answered its digests
  (it exists): owed acks first; then `GET …/intents`; for each, the policy (parked → left), the
  allow-list (`Refuse(reason)` → ack refused, `Wait` → left), then claim → apply + owed-ack row in
  one savepoint on the lane's write connection (so capture records the add as this device's op) →
  ack. The projection half that follows reads the applied rows.
- **Every five minutes while the cache says on** (`INTENTS_POLL_MS`), an intents-only round when no
  trip made a round due: the door, owed acks, the inbox. It holds the lane, as a round does.
- **The allow-list** (`intents::check`), held whatever the Worker said: `kind` one of the two; the
  payload's keys exactly the table's in §3.1; types and bounds as §3.1; `collection.add` — the card
  in this device's `cards` (else `Wait`, or refused from a current corpus), the finish one of three,
  the folder a `kind = 'user'` collection folder by `sync_uid`; `wishlist.add` — the card or the
  oracle id in `cards` (the same rule), the folder a wishlist folder no deck manages, or the root.
  Never a change, a move or a removal: there is no kind for one, and an unknown kind is refused.
- **The applier** is `collection::add_entry` (with `READER_FOLDERS`) and `wishlist::add_wish`: the
  reader's own add, an activity row, and the capture triggers' op.

## 5. Fences

- The Worker's suite: a payload with one key too many, a quantity of 0 or 100, an unknown kind, a
  body over 64 KiB and the 65th intent of a day are each refused; a token after `DELETE /g/{group}`,
  after a revoke, after a re-mint, past `exp`, with a forged MAC or for another group is a 401; the
  overlay shows a pending add at once, keeps an applied one until a publish at or past its ack
  watermark, and never a refused one; two claims, one lease.
- The core's suite: **an intent off the allow-list is refused on the device even though the Worker
  took it** (extra key, quantity 100, unknown kind, a deck folder, a managed wishlist folder, a
  folder uid that is not this group's, a removal kind); a passing add lands in the folder and in the
  sync outbox as this device's op; an owed ack is sent before the inbox is read; a parked intent is
  not claimed.
- `ipc.test.ts` parity for `IntentReview`, `ParkedIntent`, `IntentAutomatic`.
- The Rust reads the Worker's refusal codes and caps from its source (`the_headers_and_codes_are_the_workers_own`'s discipline).
