# External services, Workers and deploys

Every network dependency the app has, what "optional" means for each one, and the three
Cloudflare Workers with their deploy state and secrets. Moved out of the root
[`CLAUDE.md`](../../CLAUDE.md) without changing the wording, so every date and probe is still
here. The root file keeps only the rules every agent needs (secrets, deploy asks, optional by
construction).

> **Deploy state changes outside the repository.** Wherever a paragraph below says _deployed_ or
> _not deployed_, ask the host before you believe it or its opposite.

## Contents

- [Scryfall and the price feeds](#scryfall-and-the-price-feeds)
- [Scryfall's Tagger datasets](#scryfalls-tagger-datasets)
- [Commander Spellbook's combo feed](#commander-spellbooks-combo-feed)
- [Sync and the hosted relay](#sync-and-the-hosted-relay)
- [Entitlements, removal and leaving](#entitlements-removal-and-leaving)
- [The share Worker (read-only shared collection)](#the-share-worker-read-only-shared-collection)
- [The app Worker (the light app's web host)](#the-app-worker-the-light-apps-web-host)

## Scryfall and the price feeds

**Scryfall is the card data and the only dependency the app needs to work.** Two price feeds
join it — Card Kingdom's and Mana Pool's public bulk pricelists — and both are optional by
construction: nothing downloads until a reader selects that marketplace, and a feed that never
answers costs em dashes rather than a broken app. Card trader is deliberately absent; its API
needs a per-user JWT and publishes no bulk download. Both feeds measured live:
[the price-feed research](../superpowers/research/2026-08-12-card-kingdom-mana-pool-price-feeds.md).
Rate limits, bulk data and the penalty: [scryfall.md](../reference/scryfall.md).

## Scryfall's Tagger datasets

**Scryfall's two Tagger datasets are further bulk downloads from the same source, and optional
in a weaker sense than the price feeds are**: a launch fetches them uninvited, and what makes
them optional is that every reader of them answers without them. **Oracle Tags** say what a card
_does_ and **Art Tags** what an illustration _shows_ — what each one feeds, and why _tag_ means
only these two, is in [DOMAIN_VOCABULARY.md](DOMAIN_VOCABULARY.md).
~5.85 MB and ~12.5 MB — [the oracle research](../superpowers/research/2026-08-14-scryfall-oracle-tags.md)
and [the art one](../superpowers/research/2026-08-20-scryfall-art-tags.md).

**Both files regenerate _daily_; _weekly_ is this app's refresh interval, and the two must not be
blurred.** Scryfall's `docs/api/tags` says the bulk files are updated daily, and both `updated_at`
stamps were the previous day when checked on 2026-08-20. The week is
`tags::{oracle,art}::REFRESH_INTERVAL_SECS`, a choice this app made about how often to ask — so a
taxonomy up to seven days behind Scryfall is the design working, not a stale download.

## Commander Spellbook's combo feed

**Commander Spellbook's combo database is the third optional feed, and the first that is neither
Scryfall nor a price list.** `variants.json.gz` is where a Commander deck's bracket estimate gets
its fourth signal: a two-card infinite combo is a fact about an _interaction_, so no amount of
reading either card's own text finds one. **It is optional in the tagger files' sense and not the
price feeds'**, and it moved across that line: a launch fetches it uninvited now, because a
bracket readout drawn from three signals looks exactly like one drawn from four — no error, no
empty state, just a number a little too low — and there was no way for a reader to know a Refresh
button was what they were missing. What optional still means is that a failure keeps the combos
already stored, and an estimate with none reads three signals rather than refusing to answer.
27.5 MB gzipped over 639 MB of JSON, so the ingest streams throughout;
`combos::REFRESH_INTERVAL_SECS` is **the same week**, against a file Spellbook rebuilds through
the day, and the reason is the tagger week's: a bracket readout that changed between two sessions
on one afternoon, for a reason the reader cannot see, is the failure worth avoiding.
**Since 2026-09-08 it has a second reader that is not a deck at all**: the card modal's `Combos`
row, which asks _which combos name this card_ where the estimate asks _which combos does this
pile hold_. Two questions, never one statement — and the card side is why `combos` grew four
prose columns (**corpus schema 2**, the corpus ladder's first rung ever) and why "this card is in
no combo" and "we have never downloaded the list" have to be two different sentences.
[commander-brackets.md](../reference/commander-brackets.md) has every measurement.

## Sync and the hosted relay

**Sync is the fourth network dependency and the only one that is not a download.** Nothing about a
*membership* is fetched or sent until a reader connects one — **that is the boundary for
entitlement**, because claiming makes a group of one when the device is in none, so a single
connected device pushes and pulls with nothing ever paired to it. **Pairing crosses a boundary of
its own since 2026-08-31, and it used to need none at all**: two devices still meet with an X25519
handshake and six digits compared on both screens, but a short-lived, unauthenticated
**rendezvous** on the same relay now carries everything but the invite, so pairing itself needs the
relay reachable before either device holds a membership — two devices can no longer pair with no
signal and connect Patreon afterwards. An installation that has connected nothing has sync off,
which is the state every existing installation is in. **The relay is one Cloudflare
Worker Markus runs**, not one each reader deploys — that was the original premise and nobody
would ever have done it. **Its address is compiled into the binary as `RELAY_BASE`, is in this
repository, and is public**, in exactly the way every application's API base URL is public: the
relay can decrypt nothing it stores, and **every route that reaches a Durable Object refuses a
request without a token the relay minted** — push, pull and ack. The four entitlement routes are
not behind that gate and cannot be, because three of them exist precisely so a caller with no
token can get one, so each is guarded by something else instead (an authorization code Patreon
carries, a single-use ten-minute claim code, the refresh secret or the group auth being presented,
the webhook's HMAC). **Two `/g/…` routes stand outside it too** — `/rotate` and `/keys`, which
carry the group's own key material and refuse out of D1 alone (an accepted rotation then posts its
roster to the group's object, once): a device that has just been rotated away from cannot mint a
token, so a `/keys` behind the gate would refuse exactly the caller it exists to serve. Either way
nothing follows from knowing where the relay lives. **The hosted Worker is deployed at that
address**, which reverses what this file said until 2026-08-30. Probed that day, after the
group-key deploy: `/claim` and `/token` answer **405** to a GET (the route is there and
wants POST), `/oauth/patreon/callback` **400**, `/g/{group}/pull` **401** from the bearer gate,
`/g/{group}/rotate` **401** to a POST, `/g/{group}/keys` **401** to a GET with a well-formed
bearer, and `/g/{group}/bogus` **404** — so the gate, the callback, the membership flow and the
key distribution are all live. This sentence briefly said `/rotate` and `/keys` were the two
routes still missing; that was true for part of one day. **The device roll and the pairing
rendezvous are deployed too**, which this file denied until 2026-09-28 on a probe that could not
fail — [the runbook](../reference/hosted-relay-deploy.md)'s step 0 has one that can. **The last
deploy was 2026-10-01 at 22:09 UTC**, and carried rate limits on the five routes a caller reaches
with no token — in the Worker, because `workers.dev` has no zone for a rule, so they spare the D1
read and not the request, and they bound a flood rather than metering a trickle. The deploy before
it, the same day from `main` at `2b845048`, carried issue #548's `dev` claim on the tokens the
relay mints. ⚠️ **This sentence named `1512ea68` and #541 until that day, and was two
deploys behind**: issue #546's half went out on 2026-09-28 at 19:57 UTC, nobody wrote it down, and
step 0's sixth probe found it live three days later. The next deploy is an **update** with a D1 that holds real entitlements, not a
first landing. **What the tree holds past that deploy, since 2026-10-04, is what a browser needs
and a native client never did** — an allow-list of origins a page may ask from (`APP_ORIGINS`,
`relay/src/cors.ts`), the pre-flight answered ahead of every limiter and every Durable Object, and
`/ws` taking its bearer from the socket's sub-protocol, which is the only place a browser can put
one (`relay/src/ticket.ts`). A request with no `Origin` is answered byte for byte as before, so no
released build notices. **Written and not deployed**: asked that day, the deployed relay answered
an `OPTIONS` from the web app's origin 405, and the runbook's step 0 has the probes that say when
that has changed. **`PATREON_CLIENT_ID` beside it was a placeholder until 2026-08-30 and holds the
real id now**, public on the same terms and verified live against Patreon's authorize endpoint.

## Entitlements, removal and leaving

**An entitlement is a property of the GROUP, not of the device that pressed Connect** — so a
reader may pair first and connect second, and every device in the group reads *Supporting since
…*. Any paired device derives its own relay credential from the group key and mints its own token,
which is why **pairing does not carry the refresh secret**: the relay retires that secret with
the one device `/claim` recorded as holding it, so a copy on any other device would outlive that
device's removal and go on minting tokens for the group that removed it. **A removal reaches every
device**: it rotates the group key, rewraps it per remaining device, publishes the set, and
commits only when the relay accepts it — and the published manifest's key set *is* the roster, so
a device it omits leaves the group on its next sync. **A device can also leave of its own accord,
and that press is always possible** — everything after the in-a-group check is best effort,
*planning included*, and the local clear runs whatever the relay answered; what a failure costs is
the courtesy of telling the others, never the departure. Leaving takes the membership with it,
which is why **`/claim` moves a binding rather than refusing one**: without that, the paying
device that left could never connect anywhere again. **Five devices to a membership**, which is
the same count as five to a group because a subject holds exactly one — the relay is the fence,
the app is the message, and the cap's refusal is a **403 carrying `code: "device_limit"`**,
matched on the code and never on the sentence.

**What must never be committed are the three secrets the Worker holds** —
`PATREON_CLIENT_SECRET`, `PATREON_WEBHOOK_SECRET` and `RELAY_HMAC_KEY`, in
[the hosted-relay design](../superpowers/specs/2026-08-29-hosted-relay-and-patreon-design.md)
§9. They are set with `wrangler secret put` and belong in no `.dev.vars` either. A reader who
wants their own relay still can: `relay/` is the whole source and a fork changes that one
constant. [sync.md](../reference/sync.md) has the whole record.

## The share Worker (read-only shared collection)

**A read-only shared collection is the fifth, it is a _second_ Worker beside the relay, and it
has been deployed since 2026-10-01 without a single share published through it.** A share is a snapshot the owner
publishes rather than a window onto their database, so a viewer needs no account and no app and
the link is the whole of the capability — while *publishing* is Patreon-gated by the same bearer
token sync mints. It is the one place the relay's "it can decrypt nothing it stores" stops
holding: **a snapshot is stored in the clear**, which is what buys the OpenGraph card in Discord,
and is why six collection columns are _absent_ from the format rather than switched off in it.
**`share::publish::SHARE_BASE` is that Worker's address**,
`https://mtg-grimoire-share.denmark-east.workers.dev`, compiled in and public on `RELAY_BASE`'s
terms, and equal byte for byte to the `SHARE_BASE` var in `share-worker/wrangler.jsonc`. It was a
placeholder until the deploy, so **every release before the one that carries it still refuses a
press in words rather than publishing**. Its one secret is the relay's own `RELAY_HMAC_KEY`, the
same value on both Workers; ask the host before you believe any of this or its opposite.
[collection-sharing.md](../reference/collection-sharing.md) is the record, and lists what only a
real publish can settle.

## The app Worker (the light app's web host)

**A _third_ Worker is the light app's web host, and it has been deployed since 2026-10-04.** `app-worker/` serves
the web build, `dist-web/`, at **`https://mtg-grimoire.app`** — static assets, one `_headers` file
that carries the Content-Security-Policy and the caching, and a script of a few lines whose whole
job is that a missing file is a 404 and never the document. Beside the other two for the share
Worker's reason, blast radius, and unlike them it holds **no secret and no binding but its
assets**: no D1, no R2, no `vars`. **The origin is the app's identity, not an address that can
move** — a browser keys both OPFS databases, the service worker and the install to it, and the
relay's CORS allow-list names it (`APP_ORIGINS`, `relay/src/cors.ts`). Its policy's `connect-src`
is exactly the hosts the engine asks, and a test reads the engine's shipped Rust to hold it there:
a host that moves, and a new address written as a literal, are each a red build. **The relay is
one of those hosts**: a page asks it as every other host does — the engine refuses nothing for
being in a browser — so the policy's entry and the relay's allow-list are one fact in two
deploys, and **the relay's deploy comes first**: a page that asks a relay with no CORS answers
fails every request. The policy names `https://` only; the live socket's `wss://` is not in it
until a browser has opened one. ⚠️ **No build that asks the relay from a page is deployed** — the
tree is ahead of both hosts. **An address a server sends is not**
— Scryfall's bulk-file host is in no line of ours, so if that moves every suite stays green and
a browser's first run fails. **The last deploy was 2026-10-04 at 13:27 UTC, from `main` at
`4929cc6e`** — the second that day, rolled back at 13:28 and forward again at 13:30 to see a
rollback work, so **production is that commit and not `main`**, which has moved past it. This
paragraph said *not deployed* until then. No agent may deploy it unasked: each of
those was run by an agent because Markus asked for it, and **the ask is per deploy** — except
that for the light app's phase 6 he asked once for the phase's deploys, the relay's and this
Worker's (2026-10-04), and for nothing after it. **One job deploys it, and it is the only job
that deploys anything** (decided 2026-10-04): `release.yml`'s `web-deploy`, at a release tag,
once the values it needs exist in the `release` environment — the three hosts ship from one
tag, because a web app ahead of the last release sends paired desktops ops they must hold
([ci-and-releases.md](../reference/ci-and-releases.md), *The release rule*). **So merging the
release PR is a deploy of this Worker.** The tool is `wrangler` at the version
`app-worker/package-lock.json` pins, with everything under it — installed with no lifecycle
script run, by the job and by hand alike. Between releases a deploy is still by hand and still
asked for, and **`npm run web:deploy-guard` is run first**: it refuses a tree whose user schema
is not the last release's, or whose last release is still a draft — and it cannot see a wire
change that is not a schema rung. The relay and the share Worker are deployed by no job.
[`app-worker/README.md`](../../app-worker/README.md) is the runbook, with every probe in it answered
at the real address that day. **Who has run it**: headless Chrome 154, driven and measured; the
owner's Firefox and the owner's phone, a sentence each. What nobody has seen — Safari, an
installed app, a phone's figures, the app's own update check in a browser that was measured —
and the one policy violation known on the live site, the deck note editor's — **fixed in the
source that day, and raised by the deployed build until the next deploy** — are in
[light-app.md](../reference/light-app.md) §9.7. Ask the host before you believe this or its
opposite.
