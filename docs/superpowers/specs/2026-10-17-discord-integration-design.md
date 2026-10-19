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
  **Closed in the relay on its own (2026-10-19)**, after PR 1's revert took the warn-only check
  with it: push and ack now refuse a body naming a device other than the token's `dev` with
  `403 device_mismatch` — refusing from the start, because every token carries `dev` and every
  client names that same id — and the object stores no ack cursor past the log's newest row. The
  relay's README, "Binding the token's device". §8's `dev` binding and §11's "(warn-only first)"
  are that change and need not be built again.
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
