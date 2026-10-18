# `infrastructure/discord-worker/` — the Discord front

The Discord integration's internet-facing Worker, `mtg-grimoire-discord`, at
**`https://discord.mtg-grimoire.app`** (a Custom Domain on the web app's zone, and nowhere else:
no `workers.dev`, no preview URLs). It is half of the bot: the design is
[`docs/superpowers/specs/2026-10-17-discord-integration-design.md`](../../docs/superpowers/specs/2026-10-17-discord-integration-design.md),
and §13 is the contract this folder is built against.

**The bot is a device in the reader's sync group**, and that device is not here. It is a
Durable Object of another script, `mtg-grimoire-bot-device` (`../bot-device/`), one per link,
which holds the bot's identity, the group key and the reader's materialised data. **This Worker
holds no sync key and never sees a collection.** What it does:

- **answers Discord** at `/interactions`: it checks Discord's Ed25519 signature before it reads a
  byte as JSON, answers `/card-search` itself from Scryfall, tells a reader with no link where the
  switch is, and hands every other interaction — exactly as Discord signed it — to the reader's
  own Durable Object, returning its answer verbatim. The Durable Object checks the signature again
  itself (`src/verify.ts`, `src/interactions.ts`);
- **links a Discord account to a desktop**: OAuth2, shaped like PKCE so the desktop never sees a
  Discord token and this Worker keeps none (`src/link.ts`);
- **carries the enrolment**: the desktop's pairing invite to the bot's Durable Object, and its
  three public values back, which the desktop pins (§13.4).

## Routes

| Route                         | Caller                         | Body                                                   | Answers                                                                                                                                                                                                                             |
| ----------------------------- | ------------------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /interactions`          | Discord, signed                | an interaction                                         | `PONG` to a ping; `/card-search` and its choices; for anybody else's command, the Durable Object's answer verbatim, or an ephemeral _Switch on Discord in MTG Grimoire → Settings → Integrations_ with no link; `401 bad_signature` |
| `POST /link/begin`            | the desktop                    | `{ challenge }`, base64url SHA-256 of a verifier       | `200 { code, authorizeUrl, expiresAt }`; `429 rate_limited` past ten a minute from one address                                                                                                                                      |
| `GET /oauth/discord/callback` | the reader's browser           | Discord's `code` and `state`, or `error=access_denied` | a self-contained page: linked, declined, expired, or Discord failed                                                                                                                                                                 |
| `POST /link/claim`            | the desktop, every two seconds | `{ code, verifier }`                                   | `202 { status: "pending" }`; `200 { status: "linked", secret, discordUserId, username }`, once; `403 link_mismatch`; `409 link_denied`; `410 link_expired`                                                                          |
| `POST /link/enroll`           | the desktop, `Bearer <secret>` | `{ invite, capability: "read" }`                       | `200 { deviceId, x25519, ed25519 }`; `409 already_enrolled`; `422 bad_invite`; `502 pairing_failed`                                                                                                                                 |
| `GET /link`                   | the desktop, `Bearer <secret>` |                                                        | `200 { discordUserId, username, enrolled, deviceId, paired, lastPullAt }`; `502 bot_unavailable`                                                                                                                                    |
| `DELETE /link`                | the desktop, `Bearer <secret>` |                                                        | `204`, after the Durable Object's `unlink()`; `502 bot_unavailable` and the link kept, to retry                                                                                                                                     |

Every bearer route answers `401 not_linked` to a missing or unknown secret. **Until the
application's id and public key are filled in, every route answers `503 not_configured`**; until
`DISCORD_CLIENT_SECRET` is set, the three sign-in routes do. An unknown path is `404`, a wrong
method `405`, ahead of everything.

**Every refusal is `{ error, code }`**, matched by the desktop on `code` and never on the sentence.
`bot_unavailable` (a Durable Object call that threw — the other script not deployed, or failing)
is this Worker's own addition to §13.3's table; `/link/enroll` answers that case as
`502 pairing_failed`, which is what it is to the desktop holding an invite.

### The link, and its Durable Object

- **A link secret is 32 random bytes**, base64url, answered once by the claim. Only its SHA-256
  is stored; a bearer is found by its hash.
- **The verifier is what makes the claim the desktop's**: `state` is in a browser's address bar,
  and only the desktop that began the sign-in holds the verifier behind its challenge. It is
  compared in constant time, before anything about the request's state is answered.
- **A sign-in is single-use**: the claim deletes the request in the statement that reads who it
  names, so two racing claims get one secret between them. Ten minutes long; an expired request
  is deleted when it is next read, on every begin, and by the daily sweep.
- **A link is one Discord account and one Durable Object.** The object's id is minted with
  `BOT.newUniqueId()` the first time an account's link is claimed, and kept on the link's row.
  - **Linking again while linked replaces the secret and keeps the Durable Object**, so an
    enrolled bot stays the same device and keeps its place among the group's five. The old secret
    stops working at once. Enrolling it again is `409 already_enrolled`; to put the bot in another
    group, the desktop unlinks first.
  - **Linking after an unlink mints a fresh Durable Object**: `DELETE /link` called `unlink()`,
    which deleted the old object's storage for good, and then the row.
- **No Discord token is kept**: the callback exchanges the code, asks `/users/@me` who signed in,
  and lets the token go out of scope there.

## Bindings

`wrangler.jsonc` has the argument for each, and `src/wrangler.test.ts` holds them to the code.

| Binding                                        | What                                                                                                                                                                                                                    |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DB`                                           | **The relay's D1** (`mtg-grimoire-relay`, the same id as the relay's and the share Worker's), for two tables of its own: `discord_link_requests` and `discord_links` (`migrations/`), listed in `d1_migrations_discord` |
| `BOT`                                          | The Durable Object namespace of class `BotDevice` in script `mtg-grimoire-bot-device` — the calls are `src/rpc.ts`, which the bot device's package imports as types                                                     |
| `RL_BEGIN`                                     | Ten `POST /link/begin` a minute from one address, `namespace_id` 3001                                                                                                                                                   |
| `DISCORD_BASE`                                 | `https://discord.mtg-grimoire.app`, no trailing slash; the redirect URI is built on it                                                                                                                                  |
| `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY` | Public, so `vars`: placeholders until the owner creates the application                                                                                                                                                 |
| `DISCORD_CLIENT_SECRET`                        | **The one secret**, `wrangler secret put` by the owner; never a `var`, never in `.dev.vars`                                                                                                                             |

**One cron**, `45 3 * * *`, sweeps the link requests nobody came back for. The relay owns minute
`0` and the share Worker minute `30`; the free plan allows five cron triggers per account and
**this is the third**. Logging is off (`observability.enabled: false`): a request here carries a
link secret, an invite to a sync group, or Discord's one-time code.

## The commands

`src/commands.ts` is the list `pnpm discord:register` puts on the application, PR 3's and no
more: `/collection search card`, `/wishlist search card`, `/card-search card` and
`/deck deck [format: plain|arena|mtgo|moxfield]`, every `card` and `deck` completed, as a user
install (`integration_types: [1]`, `contexts: [0, 1, 2]`). **`/collection add` and
`/wishlist add` are not registered until PR 4** gives the bot the `add` capability.

## Deploying

**No release deploys this Worker or the bot device** (the design, §9 and §11: deployed by hand;
the owner provisions the Discord application and its secrets). No job of `release.yml` names
either folder, and `scripts/release-rule.test.ts` holds that. ⚠️ **No agent deploys either,
applies a migration, sets a secret or registers the commands unasked**; `wrangler dev --local` is
the only wrangler command an agent may run on its own.

What only the owner does, in this order:

1. **Create the Discord application** in the developer portal.
   - _Installation_: **User Install** only, with the scope `applications.commands`; no Guild
     Install, no bot user.
   - _OAuth2 → Redirects_: `https://discord.mtg-grimoire.app/oauth/discord/callback`, exactly —
     Discord compares it byte for byte.
   - Copy the **application id** and the **public key** into this folder's `wrangler.jsonc` `vars`
     (and the public key into the bot device's), in a commit: both are public.
   - Reset and keep the **client secret**; it is set below and shown once.
2. **Apply the migrations to the relay's D1**, from this folder:

   ```
   npm ci --ignore-scripts --prefix ../wrangler
   node ../wrangler/node_modules/wrangler/bin/wrangler.js d1 migrations apply mtg-grimoire-relay --remote
   ```

   Never `d1 execute --file`, which runs the SQL without recording it (`migrations/README.md`).

3. **Deploy the bot device first** (`../bot-device/README.md`, with its own secret, which this Worker never holds): a binding to a
   class of a script that does not exist is a deploy wrangler refuses.
4. **Deploy this Worker**, from this folder:

   ```
   node ../wrangler/node_modules/wrangler/bin/wrangler.js deploy
   ```

   Read what it prints: the route `discord.mtg-grimoire.app (custom domain)`, the `BOT` binding to
   `mtg-grimoire-bot-device`, and no `workers.dev` address.

5. **Set the secret, after the first deploy** (the share Worker's lesson: a `secret put` before
   the Worker exists did not stick), in a terminal of the owner's own:

   ```
   node ../wrangler/node_modules/wrangler/bin/wrangler.js secret put DISCORD_CLIENT_SECRET
   ```

6. **Point Discord at it**: _General Information → Interactions Endpoint URL_ =
   `https://discord.mtg-grimoire.app/interactions`. Discord sends a signed ping and probes with bad
   signatures when the URL is saved; it saves only if the Worker answers both right, so this step
   is also the first proof the public key is the application's.
7. **Register the commands**, from the repository's root:

   ```
   DISCORD_APPLICATION_ID=… DISCORD_CLIENT_SECRET=… pnpm discord:register
   ```

   One `PUT` of the whole list as global commands, with a client-credentials token; it refuses
   without both values and prints neither. Run it again whenever `src/commands.ts` changes.

## What a deployed Worker answers

None of these holds a credential or writes anything, bar the begin's one ten-minute row.

| Request                                           | Answer                                                                                                                                                   |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /interactions`                               | `405`, `allow: POST`                                                                                                                                     |
| `POST /interactions` with no signature            | `401 bad_signature` — and `503 not_configured` while the `vars` are placeholders                                                                         |
| `GET /nope`                                       | `404`                                                                                                                                                    |
| `POST /link/claim` with `{}`                      | `400 bad_request`                                                                                                                                        |
| `GET /link` with `authorization: Bearer nonsense` | `401 not_linked`                                                                                                                                         |
| `GET /oauth/discord/callback`                     | `400`, a page: _Nothing to finish here_ — or `503`, _Discord isn't set up yet_, while the secret is unset                                                |
| `POST /link/begin` with a well-formed challenge   | `200` and an `authorizeUrl` whose `client_id` is the application's and whose `redirect_uri` is `https://discord.mtg-grimoire.app/oauth/discord/callback` |

What only a real reader shows: that the client secret is the application's (the first sign-in),
that the `BOT` binding reaches the bot device (the first enrol), and that the commands are
registered (typing `/` in Discord).

## Testing

No workerd in this tree, for the reason `infrastructure/share-worker/README.md` gives: the handler
is a plain function over an injected `Env`, driven as `worker.fetch(request, env)`.

```
pnpm exec vitest run --project discord-worker
pnpm exec tsc -p infrastructure/discord-worker
```

`src/fake.ts` stands D1 up as **a real SQLite** (`node:sqlite`, in memory) built from
`migrations/`, so every statement is run against the schema a deploy applies; the bot namespace
records every call and answers what a test says; the signer is an Ed25519 key of the suite's own;
and one stubbed `fetch` plays Scryfall and Discord's OAuth. `wrangler.test.ts` reads this
folder's `wrangler.jsonc` and the other Workers' as text.
