# Discord integration — the bot as a restricted sync device (issue #1096)

**Status: design, 2026-10-17. Nothing here is built.** It replaces a first draft of the same date
that answered commands from a snapshot the desktop uploaded; the owner rejected that shape
(*"uploading a snapshot of the users data seems like the wrong way to go about it"*), then a
read-only integration database, and chose this one: **the Discord bot is a device in the reader's
sync group**, paired like any other, holding the group key, materialising the group's data with
grimoire-core and emitting a confirmed add as a real sync op — **after sync gains per-device
signatures and capabilities**, so a compromised bot can read but cannot forge, delete, edit,
rotate or evict. Supporter-only, because sync is.

Every citation below is `file:line` at `815b2dd`.

**The owner's decisions, 2026-10-17**: the bot ships **read-only first** (PR 3) and gains `add` in
PR 4; it **counts as one of the five devices** a membership allows; this spec lands on its own and
each PR below is reviewed before it merges.

## 1. What a reader gets

Settings gains an **Integrations** group with **Discord** as its first panel. Switching it on links
the reader's Discord account (OAuth, `integration_type=1`: a *user-installed* app, so the commands
work in any server, DM or group DM with no bot invited) and pairs the bot into their sync group.

| Command | Does | Changes data? |
| --- | --- | --- |
| `/collection search card:<name>` | Shows a card from the collection: printings, finishes, quantities, folders | no |
| `/collection add card:<name> [set] [quantity] [finish] [folder]` | Adds a card — into **Added from Discord** unless a folder is named | **yes → Confirm / Cancel** |
| `/wishlist search card:<name>` | Shows a card from the wishlist | no |
| `/wishlist add card:<name> [set] [quantity] [finish]` | Adds a card to the wishlist | **yes → Confirm / Cancel** |
| `/card-search card:<name>` | Any card from Scryfall | no |
| `/deck deck:<name> [format]` | Posts a deck list — `plain` (default, with finish), `arena`, `mtgo`, `moxfield` | no |

Every `card`, `folder` and `deck` option autocompletes. **Discord forbids a command that is both
invocable and a parent of subcommands**, so the issue's `/collection <card_name>` beside
`/collection add` is spelled `/collection search` (the same for `/wishlist`).

## 2. Why this needs more than "add signatures": what the code says today

- **F1 — the roster is partial, by design.** A peer's keys enter `sync_devices` only at the pairing
  ceremony (`pairing.rs:454, 534`); adopting a rotation prunes and never inserts, because a manifest
  carries ids and no keys (`identity.rs:1253-1271`; `client.rs:1427-1450` calls the fix "a wire
  change"). A phone that did not pair the bot could not verify one bot envelope.
- **F2 — any group-key holder can evict every device or pick the next key.** `/rotate` accepts the
  group's current auth alone (`rotate.ts:338`), which derives from the group key; `check_keys`
  reads *higher epoch, no blob for me* as removal and leaves (`client.rs:1057-1060`); `adopt_page`
  tries every roster sealer (`client.rs:1212-1220`). Signed envelopes alone do not close this.
- **F3 — nothing ties an op to its envelope.** `evaluate` merges every opened batch into one list
  (`client.rs:2698-2716`) and apply attributes by `op.at.device` (`apply.rs:905-908`). A signed bot
  envelope could carry ops stamped as device A; the rule must be `op.at.device == envelope.device`.
- **F4 — the relay does not bind a token's device to the body.** Push and ack check `claims.grp`
  only (`index.ts:375-381`); an ack stores whatever `body.device` names (`group.ts:543-562`). The
  bot could ack as another device and move its compaction floor.
- **F5 — an insert is an edit.** `add_entry_filed` is an upsert by grain (`collection.rs:608-628`);
  a fresh-uid Put that meets an existing grain merges its non-grain fields (notes, tags,
  purchase price…) by last writer; a Put on a known uid is a full edit; a counter op beats a
  concurrent delete under add-wins. "Add a card" cannot be recognised by op shape alone.
- **F6/F7 — the bot's own engine would emit forbidden ops**: a `device_names` row (`identity.rs:229,
  246`), baseline claims on every pairing (`identity.rs:1101-1104`), backstop token reconciles. Its
  capture census must be exactly its capability.
- **F8 — tokens a bot mints are honoured by the share Worker and the scan inbox**: a compromised bot
  could publish a public share of the collection. Both must refuse a restricted device.

There is no Ed25519 crate in the tree (`Cargo.lock`: `x25519-dalek 3`, `curve25519-dalek 5`,
`sha2 0.10`; `crates/grimoire-core/Cargo.toml:109-119` guards one `digest 0.10` stack).

## 3. Signing identity (user schema v66)

- `sync_identity` gains `sign_secret`, `sign_public` (Ed25519), minted on absence by
  `identity::ensure` beside the X25519 mint — every existing install gets one on its next launch.
- `sync_devices` gains `sign_public`, `capability` (`NULL` = full/legacy, else `full|read|add`, no
  `CHECK` for forward compatibility) and `proto` (the sync-protocol level it advertised).
- `sync_state` keys: `roster_mode` (`open` → `signed`, one way), `signed_since` (epoch), and
  `restricted_ever` (every device id ever restricted; never cleared).
- Crate: `ed25519-dalek 2.x`, `default-features = false`, to stay on `sha2 0.10`; measure the
  engine module against `scripts/build-wasm.ts`'s 10 MB ceiling (≈8.0 MB today).

## 4. What is signed

| Object | Today | Proposed |
| --- | --- | --- |
| Op batch | AEAD under the shared key, AAD `group\0device\0epoch` (`wire.rs:165-196, 246-272`) | Encrypt-then-sign over a domain tag, group, device, epoch, the batch's HLC and the sealed bytes; carried as a clear `Envelope.sig` that old serde ignores. Verified before `open_batch`; then every op's `at.device` must equal `envelope.device` |
| Baselines and claims | Sealed batches | Signed as batches; a restricted device emits none and receivers drop any it sends |
| Rotation blob | X25519 KEK from any roster member (`identity.rs:750-757`) | Unchanged crypto; restricted and once-restricted sealers are never candidates |
| Roster | Nothing — the relay answers `Object.keys(manifest.keys)` (`rotate.ts:476`) | **A signed roster document per epoch** (§5) |
| Pairing | `pair_key` AEAD + six digits | Signing key and proto in new rendezvous slots `joinsig`/`offersig` under `pair_key`; old layouts untouched |

## 5. The signed roster document

One per epoch, stored by the relay beside the manifest and verified over its exact bytes:

```json
{ "v": 1, "group": "…", "epoch": 12, "prev": "<sha256 of the previous>", "mode": "signed",
  "step": 1, "signer": "<device>",
  "members": [ { "device": "…", "x25519": "…", "ed25519": "…", "cap": "full|read|add",
                 "proto": 1, "since": 12 } ],
  "sig": "<Ed25519 by signer>" }
```

- **Open mode** (no restricted device ever): accepted under a MAC keyed from the epoch's group key —
  sound while every key holder is a full device, and it is how existing groups learn every
  member's keys, which fixes F1 (`adopt` can now insert).
- **Signed mode** begins at the epoch `E` the bot joins, published by the full device that enables
  it. From then on a document is accepted only if signed by a `full` member of the previously
  accepted one, `prev` matches, and no once-restricted device returns as `full`. The latch is
  monotonic.
- **Removal** in signed mode only on a verified document that omits this device; an unverifiable
  answer is held, never obeyed. A device offline across more than eight epochs (`KEY_HISTORY`)
  accepts only a document signed by a full member it already trusts, or asks for a re-pair.
- Only `full` devices plan rotations, departures, joins and removals; the bot's capability is set
  by the device that pairs it and changes only by a full device's document.

## 6. Capabilities on apply

- **`read`** (first ship): every op from the device is refused, consumed and logged once per page;
  the watermark passes it so it cannot pin the log.
- **`add`** (later): a stateless allow-list in `client::evaluate` — `Put` only; no baseline,
  emission or horizon; `collection_entries` or `wishlist_entries` only; `counters == {quantity: n}`,
  `1 ≤ n ≤ 99`; either no fields (an increment) or card-identity fields only (no notes, tags,
  prices, sources); folder parent a `kind='user'` collection folder or a wishlist folder. Then
  stateful guards in `apply::write_group`: a create on a known uid is applied as an increment; a
  grain match takes only the counter; and **restricted ops lose every last-writer and add-wins
  contest against unrestricted ones** (`merge::fold_remembering`, `Memory::merge`), so a bot add
  can never resurrect a row a reader deleted. The *Added from Discord* folder is created by the
  desktop when the integration is switched on; the bot never creates folders.
- What a compromised `add` bot can still do: add cards, in bulk. The relay caps a restricted
  device's pushes per day; removing the device ends it.

## 7. Compatibility

- Signatures are optional and verified-when-present until signed mode, so groups without a bot are
  unaffected and old builds keep syncing with new ones.
- **The gate**: the bot can be enabled only when every member of the roster document has a signing
  key and `proto ≥` the needed level, the relay advertises signature support on `/keys`, and the
  group has room. Otherwise: *Update or remove <device> first.* Pairing an old build into a signed
  group is refused on both sides; the v66 rung refuses a downgrade.
- The `add` capability's allow-list is frozen; widening it is a new capability name and gate.

## 8. Relay changes

`log.sig` column (Durable Object migration) stored and served; `group_keys.roster` (D1 migration)
stored and served with `sig: 1` on `/keys`; in signed mode `/rotate` verifies the document against
the previous one's full members (`403 unsigned_rotation`); push and ack bind the token's `dev` to
`envelope.device` / `body.device`; per-day quotas for restricted devices; the share Worker and the
scan inbox refuse a restricted `dev`. **Device limit**: the bot takes one of the five slots unless
the owner decides otherwise. The relay ships with the release, ahead of clients.

## 9. The bot runtime

- **Two scripts.** `infrastructure/discord-worker` (internet-facing: `/interactions`, the OAuth
  link, routing by Discord user) holds no keys and talks over a narrow Workers RPC to
  `infrastructure/bot-device`, one Durable Object per link, which **verifies Discord's signature
  itself**, holds the identity, and runs the engine.
- **Storage**: a new host crate, `crates/grimoire-bot`, runs grimoire-core over a SQLite page-store
  VFS on the Durable Object's synchronous SQL storage, pages AEAD-encrypted under a `BOT_KEK`
  secret. An in-memory database is not viable at 128 MB per isolate.
- **Corpus**: a slim corpus of only the printings the group references, from Scryfall's
  `/cards/collection`; reads answered by narrow queries in the host crate.
- **Deck lists**: the golden-fenced TypeScript export writer, in the Worker.
- **Freshness**: no live socket; a command is answered deferred, after a pull, and an alarm pulls
  periodically. First materialisation is paged across alarms.
- **Pairing without six digits**: the desktop links the Discord account, creates the folder, begins
  a pairing as initiator and hands the invite to the bot's Durable Object over TLS; the bot joins
  and returns its public keys in the same HTTPS answer, and the desktop **pins** them against what
  the rendezvous carried — two independent channels instead of a person comparing digits. The
  desktop alone sets the capability.
- **Leaving**: switching the integration off removes the device (a rotation) and deletes the
  Durable Object's storage; so does a membership lapsed past thirty days.

## 10. Residual risks

| Risk | Mitigation |
| --- | --- |
| **The operator holds a decryptable copy** — for a group with the bot, "the relay can decrypt nothing it stores" no longer holds in spirit | Opt-in, supporter-only; said in the enable dialog and `privacy.html`; bot script, secret and namespace apart from the relay's; off = removal + `deleteAll` |
| Keys beside internet-facing code | Two scripts, narrow RPC, Discord's signature checked inside the Durable Object, encrypted page store, no plaintext logs |
| A compromised bot with `read` | Reads everything; cannot write, rotate, evict, ack as others or publish shares |
| A compromised bot with `add` | Bulk adds, capped per day by the relay; the reader removes it |
| A device that never verifies | The gate and the downgrade cut |

## 11. The plan — four PRs, each one feature commit

1. **Signing identity and signed envelopes, verified when present.** Rung v66, `ensure` mints
   Ed25519, `Envelope.sig`, sign on push and baselines, the `at.device == envelope.device` check;
   relay `log.sig` and the `dev` binding (warn-only first). No behaviour a reader sees.
2. **The signed roster document and capabilities** (signed mode reachable from tests only).
   Fixes the partial roster; removal only on a verified document; relay verifies rotations in
   signed mode; rendezvous `joinsig`/`offersig`; share and scan Workers refuse a restricted device.
3. **The bot device, read-only**: `crates/grimoire-bot`, `infrastructure/bot-device`,
   `infrastructure/discord-worker`, the pinned pairing, Settings → Integrations → Discord, and the
   read commands. Deployed by hand; the owner provisions the Discord application, `DISCORD_CLIENT_SECRET`
   and `BOT_KEK`.
4. **The `add` capability with Confirm / Cancel**: the allow-list, the apply guards and the
   restricted rank, the relay's quotas, `/collection add` and `/wishlist add`.

## 12. PR 2's wire contract (2026-10-17)

The engine and the relay are built against these definitions; both suites pin them.

**The roster document (RD)** is a JSON *string*, stored and served verbatim and never
re-serialised. Its shape is §5's minus `sig` (the signature travels beside it):

```json
{ "v": 1, "group": "<group id>", "epoch": 12, "step": 0, "prev": "<hex sha256 of the previous RD string, or null>",
  "mode": "open" | "signed", "signer": "<device id>",
  "members": [ { "device": "<id>", "x25519": "<b64url>", "ed25519": "<b64url>", "cap": "full" | "read",
                 "proto": 1, "since": 12 } ] }
```

- **Authenticator, exactly one of two**:
  - `rosterSig`: Ed25519 by `signer` over `b"mtg-grimoire/roster/v1" ++ 0x00 ++ <RD string bytes>`, base64url without padding (86 characters).
  - `rosterMac` (open mode only): HMAC-SHA256 over the same bytes, base64url without padding (43 characters). The key is `HKDF-SHA256(ikm = the group key of the RD's epoch, salt = group id bytes, info = "mtg-grimoire/roster-mac/v1")`.
  - In signed mode only `rosterSig` is accepted, and `signer` must be a `full` member of the previous accepted RD.
- **One chain per group.** RDs are ordered by `(epoch, step)`. `prev` is the hex SHA-256 of the latest stored RD's string, and is `null` only for a group's first. A new epoch starts at `step: 0`; an amendment at the same epoch is `step + 1`.
- **The relay keeps the chain linear.** A new RD whose `prev` is not the hash of the latest stored one is refused `409 roster_conflict`; the client refetches and retries.
- **Mode is a latch.** Once any stored RD says `signed`, every later one must too.
- **Amendments.** A device adds or updates its own member entry (its keys, its proto) with an amendment, in open mode under the MAC. That is how groups paired before v66 learn every member's signing key without a rotation.
- **Storage** (D1, `infrastructure/relay/migrations/`): `rosters(group_id TEXT, epoch INTEGER, step INTEGER, roster TEXT NOT NULL, mac TEXT, sig TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (group_id, epoch, step))`.

**Routes**

| Route | Change |
| --- | --- |
| `POST /g/{group}/rotate` | Body may carry `roster` with `rosterMac` or `rosterSig`, for `epoch` = the rotation's new epoch and `step: 0`. Optional while the group is in open mode, so older builds can still rotate. Required and `rosterSig`-verified once signed (`403 unsigned_rotation`). |
| `POST /g/{group}/roster` (new) | Group auth as `/rotate`'s door. Body `{ roster, rosterMac? , rosterSig? }`. Stores an amendment at the current epoch, under the chain and mode rules above. `409 roster_conflict`, `403 unsigned_roster`, `400 malformed_roster`. |
| `GET /g/{group}/keys` | Also answers `roster`, `rosterMac`, `rosterSig` (the latest RD, or `null` for each), `rosters` (every RD from the caller's `since` epoch onward, oldest first, for a catch-up walk; capped at 16), and `sig: 1`. |
| `POST /token` (group door) | The minted token gains a `cap` claim when the latest RD names the device with a `cap` other than `full`. |
| `POST`/`GET /p/{rv}/{slot}` | The slots `joinsig` and `offersig` join `offer` and `join`, with the same ten minutes and the same first-writer-wins (stored in a table of their own, `pairing_slots`, because `pairing_rendezvous.slot`'s `CHECK` cannot be widened in place). |

**Refusals that depend on mode.** While a group's latest RD is `signed`:
- the token-device binding refuses: `403 device_mismatch`;
- a push from a member whose `cap` is not `full` is still stored (it may carry nothing a peer will apply, and every peer refuses it), but the relay keeps it under a per-device daily cap: `429 restricted_quota`.

Outside signed mode the device binding stays warn-only. **The share Worker and the scan inbox refuse a token whose `cap` claim is present and not `full`** (`403 restricted_device`).

## 13. PR 3's contract (2026-10-18)

Four parts are built against this section in parallel: the bot runtime (`crates/grimoire-bot`,
`infrastructure/bot-device`), the Discord front (`infrastructure/discord-worker`), the engine and
desktop enable flow, and the page. Every part pins the names below.

### 13.1 The two Workers

- **`mtg-grimoire-discord`** (`infrastructure/discord-worker/`, `https://discord.mtg-grimoire.app`,
  a Custom Domain, no `workers.dev`). It is internet-facing. It holds **no sync key**.
  - Binds: D1 (the relay's database, migrations table `d1_migrations_discord`), the bot's Durable
    Object namespace as `BOT`, and a rate limiter.
  - Vars: `DISCORD_BASE`, `DISCORD_APPLICATION_ID` and `DISCORD_PUBLIC_KEY`, placeholders until the
    owner fills them; the Worker answers 503 while they are placeholders.
  - Secret: `DISCORD_CLIENT_SECRET`.
- **`mtg-grimoire-bot-device`** (`infrastructure/bot-device/`). It has **no route and no
  `workers.dev`**; only the front reaches it, through `BOT`.
  - It exports the Durable Object class `BotDevice`, which uses SQLite storage
    (`new_sqlite_classes`).
  - Secrets: `BOT_KEK` (32 bytes, base64url) and `DISCORD_PUBLIC_KEY` as a var.
  - It holds the bot's identity, the group key and the materialised database. Each Durable Object
    is one link.

### 13.2 Front ⇄ Durable Object (Workers RPC on the `BOT` stub)

```ts
interface BotDeviceRpc {
  enroll(req: { invite: string; capability: "read" }): Promise<
    | { ok: true; deviceId: string; x25519: string; ed25519: string } // base64url, no padding
    | { ok: false; code: "already_enrolled" | "bad_invite" | "pairing_failed"; error: string }
  >;
  interaction(req: { body: string; signature: string; timestamp: string }): Promise<{
    status: number;
    contentType: string;
    body: string;
  }>; // the DO re-verifies Discord's signature over the raw body itself
  status(): Promise<{
    enrolled: boolean;
    deviceId: string | null;
    paired: boolean;
    lastPullAt: number | null;
    error: string | null;
  }>;
  unlink(): Promise<void>; // `ctx.storage.deleteAll()`; the identity is gone for good
}
```

The Durable Object id is minted by the front with `BOT.newUniqueId()` when a link is first
claimed, and stored on the link row.

### 13.3 Desktop ⇄ front (HTTPS)

| Route | Body | Answers |
| --- | --- | --- |
| `POST /link/begin` | `{ challenge }`, where `challenge` is the base64url SHA-256 of a verifier | 200 `{ code, authorizeUrl, expiresAt }` |
| `GET /oauth/discord/callback` | Discord's `code` and `state` | an HTML page |
| `POST /link/claim` | `{ code, verifier }` | 202 `{ status: "pending" }`; 200 `{ status: "linked", secret, discordUserId, username }`; 403 `link_mismatch`; 409 `link_denied`; 410 `link_expired` |
| `POST /link/enroll` | Bearer secret; `{ invite, capability: "read" }` | 200 `{ deviceId, x25519, ed25519 }`; 409 `already_enrolled`; 422 `bad_invite`; 502 `pairing_failed` |
| `GET /link` | Bearer secret | 200 `{ discordUserId, username, enrolled, deviceId, paired, lastPullAt }`; 401 `not_linked` |
| `DELETE /link` | Bearer secret | 204. The front calls `unlink()`, then deletes the link row |

- `invite` is exactly `pairing::Offer.code`, the text the joiner's `pairing::accept` takes.
- `authorizeUrl` asks for `scope=identify applications.commands` with `integration_type=1` and
  `state=<code>`.
- The link secret is 32 random bytes, base64url; the front stores only its SHA-256.

### 13.4 The pinned pairing (engine)

1. The desktop runs `pairing::begin`, then `POST /link/enroll`. The bot's Durable Object runs
   `pairing::accept(invite)`, which posts `join` and `joinsig`, and answers its three public values.
2. The desktop polls as usual. When the joiner's response arrives,
   `pairing::confirm_pinned(db, pending, Pinned { device_id, x25519, ed25519, capability: "read" })`
   refuses unless the joiner's device id and both keys equal the pinned ones (`PIN_MISMATCH`).
   Otherwise it confirms without six digits, posts `offer` and `offersig` (`mode: "signed"`), and
   **enters signed mode**: it publishes the first signed RD at the new epoch E, signed by this
   device, naming every member with their keys and proto, and the bot with `cap: "read"`.
3. The bot completes as a joiner normally does, adopts the signed RD, and begins pulling.

### 13.5 The gate (engine, asked before step 1)

`integration::gate(conn)` answers `Ready` or one refusal sentence for each of these:
- not in a group;
- this device's membership is not entitled (supporter-only);
- the relay has not advertised `sig: 1`;
- no accepted RD yet;
- a member without a signing key, or below `SIG_PROTO` 2, named;
- five devices already in the group;
- a restricted device already present.

### 13.6 The desktop's commands and IPC mirror (`packages/ui/lib/ipc/discord.ts`)

```rust
#[serde(rename_all = "camelCase")]
pub struct DiscordStatus {
    pub linked: bool,
    pub username: Option<String>,
    pub discord_user_id: Option<String>,
    pub linking: bool,
    pub link_expires_at: Option<i64>,
    pub enrolled: bool,
    pub bot_device_id: Option<String>,
    pub last_pull_at: Option<i64>,
    pub gate: Option<String>, // `None` = ready to enable; `Some(sentence)` = why not
}

pub struct DiscordLinkStart {
    pub authorize_url: String,
    pub expires_at: i64,
}
```

Commands:
- `discord_status`: local, plus the gate.
- `discord_link_begin`, then `discord_link_poll`: the PKCE poll, every two seconds from the page.
- `discord_link_cancel`.
- `discord_enable`: gate, `begin`, enroll, pinned confirm. It answers `DiscordStatus`.
- `discord_disable`: `pairing::remove_device(bot)`, then `DELETE /link`, then forget locally.

All of them are desktop-only. The base is `DISCORD_BASE = "https://discord.mtg-grimoire.app"`,
with the `discord_url` override in `sync_state`.

### 13.7 What the bot answers (read-only)

| Command | Answered by | From |
| --- | --- | --- |
| `/card-search card` | the front itself, with no Durable Object | Scryfall `cards/named?fuzzy=`; autocomplete from `cards/autocomplete` |
| `/collection search card`, `/wishlist search card` | the Durable Object | its own database: entries by card name, joined to its slim corpus |
| `/deck deck [format]` | the Durable Object | the deck's cards, written by the TypeScript export writer in `plain` (with finish), `arena`, `mtgo` or `moxfield` |

- **Freshness.** The Durable Object answers from what it holds. When its last pull is over two
  minutes old it pulls in an alarm, never inside an interaction.
- **Slim corpus.** Printings its rows reference and it lacks are fetched from Scryfall's
  `/cards/collection` in batches of 75. It keeps the name, set, collector number, finishes,
  normal image URI, type line and USD price.
- **Not linked.** A reader with no link gets an ephemeral sentence pointing to Settings →
  Integrations.
- **No adds.** `/collection add` and `/wishlist add` are not registered until PR 4.
