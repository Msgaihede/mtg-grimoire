# Integration data access — how a server-side reader gets at a collection

**Status: decided, 2026-10-24. Nothing here is built.** The owner asked for a reconsideration of
how cloud-side components reach a reader's data, prompted by four issues and by the expectation of
more integrations after them. This document weighs the ways of doing that and recommends one; **the
owner chose the recommendation, option B (§4), the same day.** The tracking issue carries the
implementation brief and the defaults taken for §9's remaining knobs.

The issues: [#1395](https://github.com/Msgaihede/mtg-grimoire/issues/1395) (an MCP server over the
collection and decks), [#1096](https://github.com/Msgaihede/mtg-grimoire/issues/1096) /
[#1102](https://github.com/Msgaihede/mtg-grimoire/issues/1102) (Discord slash commands, built on
`integrations/discord` and not merged), and
[#1059](https://github.com/Msgaihede/mtg-grimoire/issues/1059) (collaborative trades between two
readers). The scope is wider than the four: **any integration that reads a reader's collection, and
preferably writes to it, from somewhere that is not one of their paired devices.**

Every citation is `file:line` at `origin/main` 3874562 unless it names the branch.

---

## 1. The question, stated precisely

Sync today is **an end-to-end encrypted op log**. Every synced write becomes an op
(`crates/grimoire-core/src/schema.rs:6214-6237`, `sync_engine/merge.rs:89-124`); up to 200 ops are
sealed with XChaCha20-Poly1305 under the group key into an envelope whose six clear fields are
`group`, `device`, `epoch`, `hlcMs`, `hlcCtr` and `sealed` (`sync_engine/wire.rs:97-122`). The
relay stores the envelope and can read the routing fields, the ciphertext length and the timing
of pushes, pulls and acks — nothing else. A new device catches up by replaying the compacted log
plus the baselines its peers emit for it (`sync_engine/baseline.rs`); a baseline is full state
sent through the same log under the same key. There is no snapshot artifact anywhere.

The group key is minted on the first device, lives in the clear in `user.db`
(`schema.rs:6117-6129`) and reaches a new device only through the pairing ceremony. It rotates on
every join, removal and departure (`sync_pair/identity.rs:574-590`), and the relay holds only an
HKDF-derived auth value, never the key.

**So nothing server-side can answer "does this reader own Lightning Bolt?" today, and that is by
construction.** All four issues need exactly that answer with the reader's PC off. There is no
cryptographic arrangement that lets a server answer such a question without being able to read
that fact; searchable or homomorphic encryption is not a practical or auditable option for a
one-person project (§5.E). The real question is therefore not *whether* a server-side component
holds something readable, but:

1. **what** it holds (everything, or a curated projection),
2. **for how long** (history, or current state),
3. **under which key** (the group key, or none of the group's keys),
4. **what it can do** with it (read only, propose writes, or write into sync as a peer),
5. **how many of them** there are (one per integration, or one per group),
6. and **what the privacy page can honestly say**.

"Operations replay versus snapshotting" is a false choice at the sync layer. Device-to-device sync
stays an op log whichever way this goes; the ops are what let two devices resolve conflicts
without a server. The choice is about **the shape of the server-side reader** and about **how a
write from outside the group gets in**.

## 2. Two precedents already set

**The share Worker (2026-09-08) already stores reader data in the clear, on purpose.** A share is
"a snapshot the owner publishes, not a window onto their database"
(`infrastructure/share-worker/README.md:7`). It is gzipped JSON in R2, readable by Cloudflare and
by the owner of the service, and the UI must say "anyone with the link", never "private" or
"encrypted" (README:25-38). Its fence is **absence, not a switch**: `purchase_price`,
`purchase_currency`, `acquired_at`, `acquisition_source`, `notes` and `tags` are not in the format
(`apps/desktop/src-tauri/src/share/snapshot.rs:24-29`); condition, language and market value are
opt-in `fields` (`snapshot.rs:31-35`). A 50 000-card binder is 2.07 MB gzipped. The desktop
republishes a share it owns every five minutes when its digest changed
(`packages/ui/features/collection/useShareAutoUpdate.ts:26`, `share/publish.rs:765-830`).

**The Discord design (2026-10-17) went the other way.** Its first draft answered commands from a
snapshot the desktop uploaded; the owner rejected that ("uploading a snapshot of the users data
seems like the wrong way to go about it"), then a read-only integration database, and chose the
bot as **a device in the reader's sync group**: paired like any other, holding the group key,
materialising the group with grimoire-core compiled to wasm inside a Durable Object, emitting a
confirmed add as a real sync op. Because any group-key holder could until then forge, evict and
rotate (spec §2, F1–F8), that choice required signed envelopes, a signed roster document, a
`cap` claim, apply-side allow-lists and a protocol level bump first. All four PRs are on
`integrations/discord` (181 files, +33 678/−5 660 against `origin/main`); PRs 1 and 2 were merged
to `main` and reverted (779af2a). The bot "has never run" (branch spec §14). Its residual-risks
table says it plainly: *"the operator holds a decryptable copy — for a group with the bot, 'the
relay can decrypt nothing it stores' no longer holds in spirit."*

**A key-holding device hosted by the operator is not a privacy-preserving design either.** The
reader does not run the bot; the operator does. The moment a Durable Object holds the group key,
the operator can decrypt everything the group has synced — every table, notes and purchase prices
included, and the log's history for as long as the relay keeps it — not only what a slash command
needs. End-to-end encryption means the ends are the reader's devices; a third party holding the
key is, by definition, not that, and the spec's residual-risks table says so. So the trust the
reader extends is the same under either precedent: *the operator can read my collection.* What
differs is **how much** can be read, **for how long**, and **whether the holder can also write**.

The two precedents disagree, and the disagreement is the decision in front of us. The share
Worker says: a curated, derived, readable copy is acceptable when the reader chose to publish it.
The Discord design says: a readable copy is wrong, so put the key in the cloud instead. Read as
threat models rather than as taste, the first is the smaller exposure, and §4 says why.

## 3. What every integration on the table actually needs

| Integration | Needs to read | Needs to write | With the PC off? |
| --- | --- | --- | --- |
| Discord `/collection search`, `/wishlist search`, `/deck` (#1096) | collection entries with folder, wishlist, decks with cards; card names for autocomplete | — | **yes** — the owner's stated requirement |
| Discord `/collection add`, `/wishlist add` | the folder list | one add, confirmed in Discord | yes |
| MCP for a local agent (#1395, the common case: Claude Desktop, Cursor, an IDE on the same PC) | everything | everything | **no** — the agent runs on the PC |
| MCP for a hosted agent (#1395, remote) | collection, wishlist, decks | adds, deck edits | yes |
| Collaborative trade (#1059) | each party's **tradeable** cards and wishlist | one `finish_trade` per party, on their own device | partly — the room lives while both are present; the apply can wait |
| Future: deck-site sync, price alerts, a personal API token, webhooks | a projection | proposals | yes |

Three things fall out:

- **The local MCP case needs no cloud at all.** The desktop can host an MCP server itself (§7.2).
  That is most of #1395 and it is independent of everything below.
- **Nothing on this list needs history**, a conflict engine, or any table beyond collection,
  folders, wishlist, decks and deck cards. Every read is "current state of a few tables".
- **Every write is a proposal a person has already confirmed somewhere**: a Confirm button in
  Discord, an agent's tool call the user watched, a trade both parties agreed to. The issue for
  #1096 asks for exactly that. None of them needs to be a first-class sync peer to be written.

## 4. The options

### A. A cloud device holding the group key (what `integrations/discord` built)

One Durable Object per integration link is a paired device: it holds the group key and an
Ed25519 identity, replays the log with grimoire-core over an encrypted page-store VFS, keeps a
slim corpus fetched from Scryfall, and pushes confirmed adds as restricted ops.

- **Holds**: every synced table, in full, plus whatever history the relay still has; and a signing
  identity that the roster recognises. A compromise of `BOT_KEK` and the storage is a compromise
  of every opted-in group's whole collection, notes and purchase prices included.
- **Writes**: real sync ops, immediately visible to every device on its next pull. Bounded by the
  `add` allow-list, apply guards, 64 pushes/day and 64 KiB/push on the relay.
- **Prerequisites**: signed envelopes, the signed roster, capabilities, protocol level 3 on every
  member, and the share and scan Workers refusing restricted tokens — PRs 1 and 2, re-applied.
- **Per integration**: a 4.1 MB (1.58 MB gzipped) wasm module per Durable Object, one of the
  five device slots per link (`infrastructure/relay/src/groupauth.ts:91`), a corpus fetch per
  group, a re-key on every rotation. A pull holds the whole catch-up in memory (branch
  `bot-device/README.md`, "the whole catch-up"), in a 128 MB isolate, against a 128 MiB log quota.
  `BOT_KEK` cannot be rotated. Cold-start and first-materialisation times for a real group are
  unmeasured.
- **Honest privacy sentence**: "If you enable an integration, our servers hold a copy of your sync
  key and can decrypt your whole collection."

A variant worth naming, **A′: one hub device per group** serving N integrations through scoped
tokens, fixes the per-integration multiplication (one slot, one replica, one engine). It keeps
every other property of A. If the owner wants the group key in the cloud at all, A′ is the shape,
not one device per integration.

### B. A published projection, and intents (recommended)

Whichever full device completes a sync trip and finds its projection digest changed publishes a
**resolved, curated projection** of the chosen tables to an integrations store: one Durable Object
per group, SQLite inside, no key material from the group anywhere near it. Integrations are
**consumers** with scoped tokens; they query the projection and write **intents** — typed,
schema-checked proposals — into an inbox on the same object. The next full device to sync pulls
the inbox, validates each intent against an allow-list that lives in grimoire-core, applies it as
an ordinary local write (so the triggers capture it and it syncs to every device as that device's
own op), and acks it. Until then the store answers reads with the projection overlaid by pending
intents, so `/collection search` right after `/collection add` shows the card.

- **Holds**: current state of the tables and fields the reader opted into. No history, no notes
  or purchase data unless explicitly switched on, no key of the group's, no identity the roster
  knows. A compromise is a read of projections and nothing else: it cannot forge an op, evict a
  device, rotate a key or publish a share, because the object never holds a relay token.
- **Writes**: proposals, applied by a real device. They reach the devices when one of them syncs —
  which is also exactly when A's adds reach them, since a device only sees the bot's op on its own
  next pull. The bot design already said "it reaches your devices on their next sync".
- **Prerequisites in sync**: none. The op log, the envelope, the roster and the protocol level are
  untouched. The hardening in PRs 1 and 2 becomes optional (§8).
- **Per integration**: a consumer token and a handler. The store is per group, built once. No
  device slot, no engine in the cloud, no corpus (the projection denormalises name, set, collector
  number, Scryfall id and image per row, as a share does), no re-key.
- **Honest privacy sentence**: "If you enable an integration, our servers hold a copy of the parts
  of your collection you chose, so integrations can answer when your devices are off. They cannot
  change your collection; they can only propose changes that your own devices apply."

### C. Escrowed group key: the server reads the log itself

The reader uploads the group key wrapped under a server KEK; the server materialises with
grimoire-core and never writes. This is A without the device identity. It saves a device slot and
still exposes everything, still needs the engine in the cloud, and still re-keys on rotation.
Worse than both A′ and B on every axis but one. **Rejected.**

### D. Server-side plaintext as the source of truth

The classic account-and-database shape. It would end the sync design, the pairing ceremony and
the privacy posture the app is known for, and migrate every supporter. Out of proportion to four
feature requests. **Rejected.**

### E. Cryptography that lets a server compute on sealed data

Searchable encryption, proxy re-encryption, homomorphic schemes. None gives arbitrary queries over
rows at Worker speed; none has an audited library this tree could adopt; none produces a sentence
a privacy page can carry. **Rejected.**

### F. Keep a device on

A reader could leave a phone or a browser tab synced, or run a headless device. It does not help
the reader whose only device is the PC that is off, which is the case the issues describe. It is
the right answer for the **local** MCP server (§7.2) and for nothing else. **Complementary, not an
option.**

## 5. A against B, side by side

| | A / A′ cloud device | B projection + intents |
| --- | --- | --- |
| Server holds | whole collection, all tables, history while in the log, group key, signing identity | current state of chosen tables and fields; no key, no identity |
| Blast radius of a server compromise | read **and** (capability-bounded) write of every opted-in group | read of every opted-in group's projection |
| Change to sync | signed envelopes, signed roster, capabilities, protocol 3, relay roster routes | none |
| Cloud runtime | grimoire-core in wasm, page-store VFS, slim corpus, alarms | a Worker with SQLite in a Durable Object |
| Per added integration | a device (A) or a consumer of the hub device (A′) | a consumer |
| Device slots used | one (A′) or one per link (A) | none |
| Fidelity | perfect, every table | the projection format, versioned, must follow the schema |
| Freshness when every device is off | as of the last device push | as of the last device publish — the same moment |
| A write's path to the devices | the bot's op, on each device's next pull | an intent, applied by the first device to sync, then its op on the others' next pull |
| A write's visibility to the integration | immediate | immediate, as a pending overlay |
| Key-loss failure | `BOT_KEK` lost = every bot unreadable; re-pair each | nothing to lose; a device republishes |
| Memory and CPU risk | whole catch-up in a 128 MB isolate | ingest of a 13.7 MB JSON at most |
| Reuses | the sync engine | the share format, `publish.rs`'s digest-and-republish loop, the share Worker's token checks |
| Privacy claim | "we hold your key, opt-in" | "we hold the copy you chose, opt-in; we cannot write" |

Where A is genuinely better: nothing has to be mirrored, and a write is first-class the moment it
exists. Both are real. Neither is worth the key in the cloud once there is more than one
integration, and the second one — the mirror — is a cost this codebase already pays twice and
fences with tests (`packages/ui/lib/ipc.ts` against the Rust structs; `share/__golden__/` against
`ShareSnapshot`).

**On the owner's objection.** "Uploading a snapshot of the user's data" was rejected for the
Discord bot when the bot was the only integration. With several, the comparison changes: it is not
"a snapshot versus proper sync", because the sync log is already a copy on the server, only an
unreadable one. It is "a readable derived copy of chosen fields" against "a readable copy of
everything plus the key that made it". The share Worker chose the first in September, and nothing
about it has been a problem.

## 6. B in enough detail to be judged

### 6.1 The projection

Start from `ShareSnapshot` (`share/snapshot.rs:105-120`): it is already a versioned, golden-fenced
projection of folders and cards with opt-in fields, and the publish, gzip, digest and PUT code
exists. Widen it into a private `Projection v1`:

- **Tables**: collection folders (locked ones included — this store is private), collection
  entries, wishlist folders and entries, decks and deck cards. Trades, notes, todo lists, scan
  batches and the sync tables stay out.
- **Per row**: the row's `sync_uid` (so an intent and an ack can name a row), Scryfall id, name,
  set, collector number, finish, quantity, folder uid, image URI. **Absent from the format**, as
  in a share: `purchase_price`, `purchase_currency`, `acquired_at`, `acquisition_source`. **Opt-in
  fields**, per integration scope: condition, language, market value as of publish, tags, notes.
  Defaults off.
- **Publisher**: in grimoire-core, so the desktop, Android and the web host all do it; a digest per
  table decides whether anything is sent. Debounced off the end of a successful sync trip, so a
  projection always reflects applied foreign ops. The store keeps the publisher's HLC watermark
  and refuses an older one, which settles two devices publishing at once.
- **Size**: 273 B per card raw, 41 B gzipped (share §3.1): 13.7 MB / 2.07 MB for 50 000 cards.
  Publish the whole thing first (the share Worker's proven path), per-table on digest change;
  move to row deltas keyed on `sync_uid` only if a measured collection makes the whole-table
  republish hurt.
- **At rest**: a knob for the owner (§9). The plain choice is the share Worker's: in the clear in
  the object's SQLite, Cloudflare's at-rest encryption underneath. The hardened choice is the bot
  design's: payload columns sealed under HKDF(`INTEGRATIONS_KEK`, group id), with only the index
  columns the queries need (Scryfall id, normalised name, set, number, folder uid, quantity) in
  the clear. The second costs a KEK that cannot be rotated and buys protection against a storage
  dump alone.

### 6.2 The intents

An intent is `{ id, group, source, kind, payload, created_at, confirmed_by, state }` where `kind`
is from a closed list — `collection.add`, `wishlist.add` first; `deck.add_card`, `trade.apply`
later — and `payload` is schema-checked by the Worker on write and **again by grimoire-core on
apply**, against an allow-list the device owns (the branch's `open_checked` allow-list idea,
moved out of sync's apply path and into an `integration::intents` module). A device pulls the
inbox as the last step of a sync trip, applies what passes as ordinary writes (into **Added from
Discord**, or the named folder, as the Discord spec has it), records the source on the row if the
owner wants provenance, and acks with the result. A failed check is acked as refused with a reason
the integration shows. A per-kind policy decides whether a device applies silently (a Discord add
the reader confirmed in Discord) or parks it for review in the app (a kind the reader has not
auto-approved). The first device to sync applies; the others see the ack. Caps mirror the
branch's: a daily count and a byte size per integration, enforced by the store.

### 6.3 Who may talk to the store

- **Devices** authenticate as they do to the share Worker: a relay-minted token verified under the
  shared `RELAY_HMAC_KEY`, `claims.grp` against the path, `stillInGroup` against the newest
  `group_keys` manifest (`share-worker/src/env.ts:144-178`). Devices publish projections and
  pull and ack intents.
- **Integrations** authenticate with tokens the store mints: `{ grp, integration, scopes, exp }`,
  issued when the reader enables the integration in Settings → Integrations and revoked when they
  disable it. They are never relay tokens, so the branch's F8 (a bot's token honoured by the share
  Worker and scan inbox) cannot arise.
- **Nobody else.** The store has no public route. Turning the last integration off runs
  `deleteAll` on the object, as the bot design does. A lapsed membership past the grace window
  does the same, by the share Worker's lapse cron.

### 6.4 Its own Worker

A fourth Worker, `infrastructure/integrations-worker/` (name provisional), beside the relay, the
share Worker and the scan inbox, for the same reason the share Worker is not inside the relay:
a bad deploy here must not be a sync outage (share spec §5.1). It binds the relay's D1 for
entitlements and `group_keys`, and owns its Durable Object namespace. Nothing of the group key
is in its environment.

## 7. The four issues, and the ones after them, on B

### 7.1 Discord (#1096, #1102)

`infrastructure/discord-worker/` from the branch — the OAuth link, Discord's signature check, the
command and autocomplete handlers, the message formatting, the deck export writer, the Confirm /
Cancel proposal flow and its 15-minute expiry — is kept nearly whole; it reads from the store
instead of a bot object and posts an intent on Confirm instead of emitting an op.
`crates/grimoire-bot` (the VFS, the device, the slim corpus, the queries) and
`infrastructure/bot-device` are not needed. `/card-search` keeps asking Scryfall. Prices in a
reply come from the projection's opt-in market value or from one Scryfall request per shown
printing, which the add flow already makes.

### 7.2 MCP (#1395), in two tiers

- **Local, first and free**: the desktop hosts a streamable-HTTP MCP server on `127.0.0.1`, switched
  on in Settings → Integrations, with a bearer token shown there for the agent's config. It calls
  the same core functions the IPC commands call, so it reads and writes everything with full
  fidelity, at once, and nothing leaves the machine. This solves the common case of #1395 outright
  and depends on nothing in this document. It also sidesteps the single-instance trap: the running
  app serves it, no second process opens `user.db`.
- **Remote, later and supporter-only**: the integrations Worker exposes the same tool names over
  the store, reads from the projection, writes as intents. The agent sees "pending until your
  device syncs" on a write, which is the truth.

### 7.3 Trades (#1059)

A **trade room** is one more object on the integrations Worker, keyed by a room id two readers
exchange (a link, as shares are). Each party's offerable cards come from their own projection, or
from a share snapshot for a party without integrations; the room is edited live over the
object's WebSocket; "Agree" writes one `trade.apply` intent into each party's inbox, and each
party's device runs `finish_trade` (`crates/grimoire-core/src/trade.rs`) on its own collection.
That is the issue's own last sentence. Nothing in sync changes, trades still never sync, and a
party's device can refuse an intent whose lines no longer match what it owns.

### 7.4 After these

A deck-site exporter reads decks from the projection. A price-alert job reads the wishlist. A
personal API token is a consumer. A webhook ("your collection changed") fires on publish. A
partner integration gets a scope. Each is a token and a handler; none is a device, a pairing or
a protocol level.

## 8. What becomes of `integrations/discord`

- **Reuse**: `infrastructure/discord-worker/` (re-targeted at the store), the Settings →
  Integrations panel and its enable gate (simplified: no "every device at protocol 3" check), the
  privacy-policy wording about an opt-in server-side copy, the Added from Discord folder.
- **Drop**: `crates/grimoire-bot`, `infrastructure/bot-device`, `integration::add::emit`,
  `push_restricted`, the apply-side allow-list and restricted rank, `RESTRICTED_*` on the relay,
  the protocol level 3 gate.
- **Decide separately**: PRs 1 and 2 — signed envelopes, the signed roster, capabilities. They
  are no longer a prerequisite of anything here. F2 (any group-key holder can evict every device
  or pick the next key) is a real weakness of sync on its own, against a stolen or compromised
  device; it is hardening worth having at some point and worth nothing to integrations. F4 is
  already closed on `main` (`403 device_mismatch`, `infrastructure/relay/src/index.ts:62,247,302`).
  The branch is 406 commits behind `main`; whatever is kept is re-applied as fresh commits, not
  merged.

## 9. What the owner had to settle

**Settled 2026-10-24: item 1, option B, by the owner.** Items 2–6 are taken as the defaults the
tracking issue names, each overridable there.

1. **The substrate.** A server-readable, reader-curated projection as the thing every integration
   reads (B), reversing the 2026-10-17 shape — or the group key in the cloud behind one hub device
   (A′). This document recommends B.
2. **At rest.** In the clear like a share, or payload columns sealed under an `INTEGRATIONS_KEK`
   with clear index columns (§6.1).
3. **Fields.** Which opt-ins exist at all (condition, language, value, tags, notes) and that
   purchase data stays absent from the format.
4. **Writes.** Intents applied by the first syncing device, with per-kind auto-apply or in-app
   review — or read-only for v1 and intents after.
5. **Gating.** Supporter-only, as sync and shares are, or the local MCP tier free for everyone
   since it costs the service nothing.
6. **The branch.** Which of §8's "reuse" and "decide separately" lines hold.

## 10. A sequencing, if B

1. The local MCP server in the desktop (no cloud; stands alone; closes most of #1395).
2. `Projection v1` in grimoire-core, the publisher off the sync trip, the integrations Worker with
   the per-group object, Settings → Integrations with a master switch that publishes nothing until
   one integration is on, and the `deleteAll` on the last switch-off.
3. Intents: the inbox, the core applier and allow-list, the review surface in the app.
4. Discord, re-targeted; the store's first consumer.
5. Remote MCP over the store.
6. Trade rooms.

Each step is a design of its own with measurements where this document has none: the publish
time and size for a real large collection, the store's ingest time, the cold answer time against
Discord's three seconds.
