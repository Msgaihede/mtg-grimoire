# `mtg-grimoire-bot-device` — the Discord bot as a sync device

The Worker that **is** the Discord bot's device in a reader's sync group: one `BotDevice` Durable
Object per Discord link, holding the bot's identity, the group key and the group's data,
materialised by `grimoire-core` compiled to wasm (`crates/grimoire-bot`). It answers the read
commands (`/collection search`, `/wishlist search`, `/deck` and their autocomplete) from what it
holds, and pulls the group's changes in its own alarms.

It is the design's §9 and §13 (`docs/superpowers/specs/2026-10-17-discord-integration-design.md`).
The internet-facing half — Discord's `/interactions`, the OAuth link, routing by Discord user — is
`infrastructure/discord-worker/` (`mtg-grimoire-discord`), which holds no sync key and reaches this
Worker only through its `BOT` Durable Object binding.

## What it holds

| Where                                                  | What                                                                                                                                                                          | Sealed?                                                                                                                                      |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `pages(file, no, data)` in the object's SQLite storage | Every 4 096-byte page of two SQLite files: `user.db` (the identity, the group key, the group's collection, wishlist and decks as synced) and `corpus.db` (the slim card list) | **Yes** — XChaCha20-Poly1305 under a key HKDF derives from `BOT_KEK` and the object's id; the page's file and number are the associated data |
| `files(name, size)`                                    | Each file's length                                                                                                                                                            | No — a length                                                                                                                                |
| The object's alarm                                     | When it next pulls                                                                                                                                                            | —                                                                                                                                            |

Nothing else: no KV, no D1, no R2, no logs (`observability` is off). The front stores the object's
id on the link row (`discord_links.do_id`) and nothing of what the object holds.

**The slim corpus** is only the printings the group's rows reference: fetched from Scryfall's
`/cards/collection`, 75 identifiers a request, one request a second, at most four requests an
alarm, with the app's `User-Agent`. It keeps what a message shows — name, set and set name,
collector number, finishes, type line, prices, legalities and the `normal` image — and asks for a
printing again after a week, for its price. A wish for any printing is asked for by name.

## Why it has no route

`wrangler.jsonc` has no `routes`, `workers_dev: false` and `preview_urls: false`. The script holds
keys that decrypt a reader's whole collection; nothing on the internet should be able to send it a
request. The only caller is the Discord front, over Workers RPC (`BotDeviceRpc` in
`infrastructure/discord-worker/src/rpc.ts`):

| Method                                        | Does                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `enroll({ invite, capability: "read" })`      | Runs the core's `pairing::accept` on the desktop's invite (posts `join` and `joinsig` to the rendezvous) and answers `{ ok, deviceId, x25519, ed25519 }`, which the desktop pins. An alarm 1.5 s later starts polling for the desktop's confirm.                                                       |
| `interaction({ body, signature, timestamp })` | **Re-verifies Discord's Ed25519 signature over `timestamp + body` itself** (`src/verify.ts`) — a compromised front cannot make it answer a forged interaction — then answers from what it holds. Never pulls; when the last pull is over two minutes old it sets an alarm for now.                     |
| `status()`                                    | `{ enrolled, deviceId, paired, lastPullAt, error }`                                                                                                                                                                                                                                                    |
| `unlink()`                                    | Closes the engine, revokes the page store and runs `ctx.storage.deleteAll()`: the identity, the key and every page, gone.                                                                                                                                                                              |
| `alarm()`                                     | One step: a rendezvous poll while joining; once paired, one pull trip (`/keys`, a token through the group door, the core's paged pull, the ack) and a piece of the corpus; then the next alarm — 1.5 s while joining, 1 s while the corpus has more to fetch, 30 min otherwise, 5 min after a failure. |

**It never pushes.** The bot is a `read` device: capture is off (a temporary trigger refuses every
op its own writes would record), and no push, baseline, join publish or roster amendment is ever
made. Every other device refuses what a `read` device sends anyway.

**It deletes itself** when its group removes it (the pull trip's `/keys` says so), and when it has
had no relay token for 30 days — a membership that lapsed, a group that went away (the design, §9,
_Leaving_).

## Secrets and variables

| Name                                | Kind                         | What                                                                                                                                                                          |
| ----------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BOT_KEK`                           | **Secret**, this Worker only | 32 random bytes, base64url. The key every stored page is sealed under (per object, through HKDF). **Never committed and never in a `.dev.vars` in git.**                      |
| `DISCORD_PUBLIC_KEY`                | Var                          | The Discord application's public key, hex — the same value as the front's. A placeholder until the application exists; with the placeholder every interaction is refused 401. |
| `BOT_RELAY_URL`, `BOT_SCRYFALL_URL` | Local only                   | Point the engine at a local relay or Scryfall in `wrangler dev --local`. Unset in production.                                                                                 |

⚠️ **Losing or changing `BOT_KEK` makes every bot's storage unreadable**: each object then answers
_"BOT_KEK does not open this bot's storage …"_ and serves nothing. There is no re-keying; the
recovery is putting the old secret back, or each reader switching Discord off and on again (a new
pairing, a new device). Keep the value where the owner keeps the relay's secrets.

## Building

The engine is a build output, not in git:

```sh
node scripts/build-wasm.ts --only bot     # → dist-wasm/bot/grimoire_bot.js and grimoire_bot_bg.wasm
```

It needs clang 18+ (SQLite's C for wasm32) and the `wasm-bindgen` CLI at exactly the version
`Cargo.lock` pins (`cargo install wasm-bindgen-cli --version <that> --locked`); the script checks
both, the module's exports, and its size against the Workers Free plan's 3 MB-compressed limit.
**Measured 2026-10-18: 3 963 719 B, 1 536 366 B through `gzip -9`**; wrangler's own dry run says
_Total Upload: 3952 KiB / gzip: 1522 KiB_. The type-check (`tsc -p infrastructure/bot-device`) does
not need the build: `src/wasm-types/` stands in for the glue's declarations.

`src/deck.ts` imports the desktop's export writer (`packages/ui/features/transfer/export/`) by the
shared UI's package name; `wrangler.jsonc`'s `alias` resolves those modules by path, because a
deploy installs wrangler alone.

## Running it locally

```sh
npm ci --ignore-scripts --prefix infrastructure/wrangler
node scripts/build-wasm.ts --only bot
cd infrastructure/bot-device
WRANGLER_SEND_METRICS=false node ../wrangler/node_modules/wrangler/bin/wrangler.js dev --local \
  --var BOT_KEK:$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))')
```

The object has no route, so a local run needs a caller: the front's own `wrangler dev` with a
`BOT` binding to this script, or a harness Worker that re-exports `BotDevice` and calls its RPC.
**What was run on 2026-10-18** (a harness of the second kind, outside the repository): the relay
under `wrangler dev --local` with a seeded membership, a native desktop engine that claimed it,
founded a group and wrote a collection entry and a wish, `begin_integration` → `enroll` in workerd
(46 ms) → `confirm_pinned` → two alarms (paired, then pulled; ~40 ms each) → signed interactions:
`/collection search sol ring` answered `2× Commander 2021 (C21) #263 · Binder/Artifacts` with
Scryfall's image (the corpus fetched from the real Scryfall, from workerd), `/wishlist search`
answered `1× Any printing`, the autocomplete answered `Sol Ring`, a forged body was refused 401,
no stored page held plaintext, a restarted workerd answered the same from storage, and a workerd
started with another `BOT_KEK` answered the wrong-key sentence.

## Deploying — the owner's runbook

**An agent never deploys this, sets its secret or touches the account** (root `CLAUDE.md`). For
the owner, once, in this order:

1. Create the Discord application and fill `DISCORD_PUBLIC_KEY` here and in the front's
   `wrangler.jsonc` (the same value).
2. `node scripts/build-wasm.ts --only bot`.
3. From `infrastructure/bot-device`: `node ../wrangler/node_modules/wrangler/bin/wrangler.js deploy`
   — this Worker **first**: the front's `BOT` binding names this script and its class, and a
   deploy of the front before this one exists fails on that binding.
4. `node ../wrangler/node_modules/wrangler/bin/wrangler.js secret put BOT_KEK`, pasting 32 random
   bytes as base64url. Keep a copy where the relay's secrets are kept.
5. Deploy the front (`infrastructure/discord-worker/README.md`).

The `v1` migration (`new_sqlite_classes: ["BotDevice"]`) is applied by the first deploy. A later
change to the class's storage is a new tagged migration, never an edit of `v1`.

**Free or Paid plan**: the module fits the Free plan's script limit. An alarm's CPU is bounded per
step (a few Scryfall requests, one pull trip), but a first pull of a large group applies its whole
catch-up in one alarm; on the Free plan's CPU budget a very large collection may need several
alarms to get through, which the engine does by retrying from its cursor.

## Residual risk: the operator holds a decryptable copy

For a group with the bot, _"the relay can decrypt nothing it stores"_ no longer holds in spirit:
whoever controls this Worker's account controls `BOT_KEK` and the pages it seals, and so can read
the group's collection, wishlist and decks — the bot has to read them to answer. What keeps that
narrow (the design, §10):

- **Opt-in and supporter-only**, said in the enable dialog and the privacy policy.
- **Apart from the relay**: a script, a secret and a Durable Object namespace of its own, with no
  route; the internet-facing front holds no key.
- **Encrypted at rest** under a secret that is not in storage: a copy of the storage alone is
  noise. The seal does not stop an operator who has both, nor a replay of an older sealing of a
  page, and a file's length is in the clear.
- **No plaintext logs**: observability off; an engine error reaches a reader as a fixed sentence.
- **A compromised bot can read, and nothing more**: it is `read` on the signed roster, so it cannot
  write, rotate, evict, ack as another device or publish a share (PR 2's rules).
- **Off is gone**: switching Discord off removes the device (a rotation) and `unlink()` deletes the
  object's storage; so does a membership lapsed past thirty days.

## Known limits

- **A pairing in flight lives in memory.** The core keeps its pending pairing out of SQLite on
  purpose and gives a host no way to keep it, so an object evicted between `enroll` and the
  desktop's confirm (seconds, normally) goes to `failed` with a sentence at its next alarm; enabling
  again sends a fresh invite, which `enroll` accepts.
- **A pull holds one catch-up's sealed text at once.** The core fetches every page of a pull before
  it evaluates the last, bounded by the relay's 128 MiB group quota rather than by this Worker's
  128 MB isolate. Ordinary groups are far below that; a group whose catch-up approaches it needs a
  pull the core can stop after N pages.
- **`Date.now()` is frozen within an execution** in workerd. Nothing here measures work with it;
  the timestamps it stamps (a pull, a corpus row) are as precise as the last I/O.
