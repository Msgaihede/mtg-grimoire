# The relay and the share Worker on mtg-grimoire.app — design

**Date:** 2026-10-11 · **Status:** approved by the owner the same day; the code is in the pull
request that carries this file. Of the rollout (§5), steps 1 and 2 are done by the owner's word
the same day, and step 3 was done at his ask at about 16:50 UTC: both names are attached and
answered their probes. Nothing has been deployed

## 1. Goal

Every Cloudflare Worker this project runs answers on the `mtg-grimoire.app` zone, and every new
build, share link, pairing QR, policy line, probe and document names it there — while every
build already installed goes on working, untouched, at the address it was compiled with.

Success is: a build cut after this change asks `relay.mtg-grimoire.app` and
`share.mtg-grimoire.app` and nothing on `workers.dev`; a build through 0.44.0 still syncs, pairs,
connects Patreon and opens a share exactly as it does today; and the two kinds of build pair with
each other and sync in one group.

## 2. Decisions (the owner's, 2026-10-11)

| Question | Decision |
| --- | --- |
| The two `workers.dev` addresses | **Kept, indefinitely**, as a second address of the same Worker. Retiring them is a later decision of its own and nothing here prepares it. |
| Hostnames | **`relay.mtg-grimoire.app`** and **`share.mtg-grimoire.app`** — each its Worker's own name. |
| Patreon's redirect URI | **Moves.** New builds send the new one; the relay repeats whichever of its two addresses the callback arrived at. The owner registers the second URI at Patreon. |
| The hostnames' first appearance | **Attached by hand ahead of the release**, when the owner asks, so the release's own deploys restate something that already answers. |

## 3. What was found (asked of the account and read in the tree, 2026-10-11)

- **Two Workers move, not three.** `mtg-grimoire-app` has been a Custom Domain on the apex since
  2026-10-04 with `workers.dev` and Preview URLs both off. `mtg-grimoire-relay` and
  `mtg-grimoire-share` are on `denmark-east.workers.dev` alone, with `workers.dev` and Preview
  URLs both on. All three were last deployed today, by the 0.44.0 release — so
  `CLOUDFLARE_INFRA_API_TOKEN` is set and works.
- **The zone is active, on the free plan**, and holds two records: the apex and `www`, both
  proxied `AAAA 100::`. One Custom Domain exists on the account, the apex.
- **Two addresses are compiled in.** `entitlement::RELAY_BASE` (`crates/grimoire-core`) and
  `share::publish::SHARE_BASE` (`apps/desktop/src-tauri`). The share Worker's pair is held byte
  for byte by a test; **the relay's was not** — a review of this change found that nothing
  compared the constant with the var — and `relay-deploy-probe.test.ts` holds it now. Every desktop release through 0.44.0 and the Android
  bundle on Play carry the `workers.dev` values.
- **The relay reads `RELAY_BASE` in one place**: `patreon.ts`'s `redirectUri`, for the code
  exchange. Patreon compares that URI with the one the app's authorize request carried, exactly.
- **Nothing else binds a client to a host.** A pairing invite is everything after the last `#`
  (`Invite::decode`), so a QR drawn against either address reads on either build. A share link is
  checked by scheme and shape and never by host (`shareLinkFrom`, `viewer_link`). A shared page
  names its snapshot by a relative path (`page.ts`), so a page opened at either address fetches
  its snapshot from that same address. Tokens, groups and rendezvous rows are the Worker's, and
  both addresses are one Worker over one D1.
- **`workers_dev` defaults to `false` the moment a config has `routes`** (Cloudflare's
  configuration reference). A route added without `workers_dev: true` beside it would turn the
  old address off on the next deploy, with `wrangler deploy` exiting 0.
- **A release deploys the Workers before it publishes.** `relay-deploy` → `share-deploy` →
  `web-deploy` → `publish`; a build is on nobody's updater until the draft flips. Each deploy
  job's probe retries six times, ten seconds apart.
- **The web app's policy names the relay twice** (`_headers`, `https://` and `wss://`), and
  `hosting.test.ts` derives both from the Rust constant.
- **`CLOUDFLARE_INFRA_API_TOKEN` was created with no zone permission**
  (`ci-and-releases.md`): both Workers were on `workers.dev`. A deploy that states a Custom Domain
  needs Zone → Workers Routes → Edit on the zone, as the web app's token has.

## 4. Design

### 4.1 The two configs

`infrastructure/relay/wrangler.jsonc` and `infrastructure/share-worker/wrangler.jsonc` each gain:

```jsonc
"routes": [{ "pattern": "relay.mtg-grimoire.app", "custom_domain": true }],  // share.… on the other
"workers_dev": true,
```

`workers_dev: true` is written out and commented as the line that keeps every installed build
working. `preview_urls` is left unstated: omitted, wrangler does not change the existing setting.

Vars: `RELAY_BASE` becomes `https://relay.mtg-grimoire.app` and `SHARE_BASE`
`https://share.mtg-grimoire.app`. The relay gains one var, `RELAY_BASE_LEGACY`, holding
`https://mtg-grimoire-relay.denmark-east.workers.dev`. The share Worker needs no legacy var: it
reads `SHARE_BASE` only to mint a link and to write `og:url`, and both should name the new
address whichever one was asked.

### 4.2 The compiled-in addresses

`entitlement::RELAY_BASE` and `share::publish::SHARE_BASE` take the new values, with their
comments rewritten to say what the address is now and that the `workers.dev` one still answers
for the builds that carry it. `packages/fake/db.ts`'s hand copy of `RELAY_BASE` follows (held by
`qr.test.ts`), as does the literal in `invite.rs`'s test. The existing byte-for-byte tests hold
each constant to its var; none is loosened.

**The pairing QR gets smaller, which was found while building this.** The relay's address is in
the invite's URL, so 162 bytes become 141. The crate's encoder draws an invite at 45 or 49
modules depending on its bytes, never more than 49, where the old address was documented at 53.
The fake's one-symbol encoder moves from version 9 to version 8 — the largest the app draws — and
the phone-width scan smoke measures 49. The picture's box does not change: a build through 0.44.0
draws the larger symbol in it.

### 4.3 The redirect URI, per host

The only change in behaviour. `redirectUri(env, request)` answers:

- the request's own origin plus the callback path, **when that origin is `RELAY_BASE` or
  `RELAY_BASE_LEGACY`**;
- otherwise `RELAY_BASE` plus the path.

Patreon sends the reader's browser to the URI the app named, so the address the callback arrives
at *is* the URI that was authorized, and the exchange must repeat it. Two known strings and
nothing else: a `Host` the relay does not own never reaches Patreon. `handleCallback` passes its
request through `connectPatreon` to `exchangeCode`. `RELAY_BASE_LEGACY` is asked for with
`required`, beside the others, so a deploy without it is a 500 that names it rather than a relay
that fails only for old builds.

### 4.4 The web app

`infrastructure/app-worker/_headers`: the relay's two `connect-src` sources become
`https://relay.mtg-grimoire.app` and `wss://relay.mtg-grimoire.app`, and the comment's table row
follows. The old host is removed, not kept beside it: the page's engine asks only the constant.
A browser still running the previous build from its service worker has that build's policy with
it, and asks the old address, which answers.

`apps/light/public/privacy.html`: the row names `relay.mtg-grimoire.app`, and says versions
through 0.44.0 reach the same service at the earlier name.

The relay's `APP_ORIGINS` does not change — the page's origin is the same.

### 4.5 Probes and fences

- `scripts/relay-deploy-probe.ts` and `scripts/share-deploy-probe.ts`: `RELAY` and `SHARE`
  become the new addresses, and each exports a `LEGACY` address. After the full set passes at the
  new address, each asks **one** request of the legacy one (the relay's pre-flight, which spends
  no limiter; the share Worker's gate, whose `401` no switched-off name gives — such a name
  answers Cloudflare's `404`, as text, asked 2026-10-11) inside the same `askUntil`. A release that
  turned `workers.dev` off therefore stays a draft and says why.
- Their tests: the assertion that the probed address is `https://<name>.denmark-east.workers.dev`
  becomes the assertion about `LEGACY`; new assertions hold the config's route to the probed
  host, `custom_domain` to `true`, and `workers_dev` to `true`. The relay's also holds
  `RELAY_BASE_LEGACY` to `LEGACY`.
- `infrastructure/relay/src`: tests for `redirectUri` — a callback at the new address, at the
  legacy one, and at a foreign host (answers `RELAY_BASE`) — and one through `handleCallback`
  that reads the `redirect_uri` the exchange was sent.

### 4.6 Documents

Rewritten to be true: `docs/agent/EXTERNAL_SERVICES.md`; the three Workers' READMEs;
`docs/reference/` — `hosted-relay-deploy.md`, `collection-sharing.md`, `sync.md`,
`ci-and-releases.md` (the infra token's permissions, and the probes' second address); the
comments in `ratelimit.ts` and the relay's config that say a rule in front of the Worker needs a
zone `workers.dev` has none of — still true of the legacy address, which is why the limits stay in
the Worker. Dated specs and plans under `docs/superpowers/` are history and are not edited, and neither is
`docs/reference/light-app.md`: every sentence in it that names the relay's `workers.dev` address or
the 53-module invite is the dated record of a step, true of the build it measured.

## 5. Rollout

1. **The owner, at Patreon** — add `https://relay.mtg-grimoire.app/oauth/patreon/callback`
   beside the existing redirect URI on the client. Patreon's API reference speaks of a client's
   redirect URIs in the plural; the portal's own form was not seen. **This must precede the
   release**: without it a new build is refused at Patreon's consent screen.
2. **The owner, at Cloudflare** — add Zone → Workers Routes → Edit on `mtg-grimoire.app` to
   `CLOUDFLARE_INFRA_API_TOKEN`.
3. **An agent, when asked** — attach `relay.mtg-grimoire.app` to `mtg-grimoire-relay` and
   `share.mtg-grimoire.app` to `mtg-grimoire-share` through the Cloudflare API, which changes no
   code and no existing address, then run both probe scripts against the new origins. The
   deployed relay still names the old URI at the exchange, so until the release only the OAuth
   callback at the new address is not yet right — and no build asks it.
4. **The pull request** — one `feat:` commit: code, tests, documents and this spec. Merging it
   deploys nothing.
5. **The next release** deploys the relay, the share Worker and the web app, probes both
   addresses of each Worker, and publishes.
6. **Afterwards, by hand** — one Connect Patreon press from a new build, and one from 0.44.0.
   No probe without a credential can stand in for either.

If step 3 is skipped the release creates the hostnames itself; the risk is a certificate not yet
issued inside the probe's minute, which leaves the Workers deployed and the release a draft until
the job is re-run.

## 6. Failure modes

| What goes wrong | What a reader sees | What catches it |
| --- | --- | --- |
| `workers_dev: true` lost from a config | every installed build stops syncing | the config test in the pull request; the legacy probe at the release |
| Patreon not told of the new URI | Connect Patreon fails at the consent screen, new builds only | nothing automatic — step 1, and step 6's press |
| `RELAY_BASE_LEGACY` unset or misspelled | Connect Patreon fails for old builds (`invalid_grant`), or a 500 naming the binding | the config test; `required` |
| The infra token lacks the zone permission | none — the release stays a draft | the deploy job's log names the permission |
| A share minted before the change | none — its link still opens at the old address | the legacy probe |

## 7. Not in this change

- Turning either `workers.dev` address off, or measuring traffic on it.
- A rate-limiting or WAF rule on the zone in front of the new hostnames.
- Moving the Patreon webhook's address; it is delivered to the same Worker either way.
- The Preview URL setting on either Worker.
- `www`-style redirects from one hostname to another.

## 8. Verification

`pnpm verify`, once, at the end. At the host: both probe scripts at both addresses after step 3
and again after the release; the web app's probe, whose policy line now names the new relay; and
step 6's two presses, which are the owner's.
