# `app-worker/` — the web app's hosting

A third Cloudflare Worker, beside `relay/` and `share-worker/`. It serves the light app's web
build — `dist-web/`, the page and the engine compiled to WASM — at **`https://mtg-grimoire.app`**,
the origin root. It is static assets, one file of response headers, and a script of a few lines.

**Nothing is deployed there.** This directory is source, configuration and a runbook; Markus runs
`wrangler deploy`. The design is
[the light-app spec](../docs/superpowers/specs/2026-10-01-light-app-android-and-web-design.md) §6,
and the build it serves is [light-app.md](../docs/reference/light-app.md) §9.

| File | What it is |
| --- | --- |
| `wrangler.jsonc` | The Worker: its name, the custom domain, the `assets` binding over `../dist-web` |
| `_headers` | The response headers, in Cloudflare's format. The web build copies it into `dist-web/` |
| `src/index.ts` | The script: a missing file is a 404, never the document |
| `src/headers.ts` | A reader of `_headers` that answers as Cloudflare's does — for the preview and the tests |
| `src/hosting.test.ts` | The fence between the policy and the hosts the engine asks |

## Why it is not a route on either of the other two

**Blast radius**, the reason `share-worker/` gives for itself. Sync is a paid feature people
depend on, every deploy here is done by hand by one person, and a deploy of a *page* happens far
more often than a deploy of the relay. One Worker carrying both makes a bad build of the app a
sync outage.

And unlike those two it shares nothing: **no D1, no R2, no KV, no Durable Object, no `vars`, and
no secret.** The whole of what it can read is the files a build wrote, which are public by being
served. A compromise of this Worker is a compromise of a web page — serious, because the page
holds a reader's collection in their browser, but it reaches no key, no token and no other
reader's data.

## What is public, and what is not here to leak

- **The origin, `https://mtg-grimoire.app`, is public and is in this repository** — on the terms
  `RELAY_BASE` is: it is the address every reader types.
- **`wrangler.jsonc` and `_headers` are public.** A policy is not a secret; a browser prints it.
- **There is nothing to set with `wrangler secret put`**, and no `.dev.vars` belongs here.
- **The Cloudflare account id is in no file of this repository** — wrangler takes it from the
  login — and `hosting.test.ts` fails if anything shaped like one appears in this directory.

## What it answers

| Request | Answer | Who answers |
| --- | --- | --- |
| A file that exists — `/`, `/assets/…`, `/wasm/<build>/…`, the manifest | the file, with `_headers` applied | the edge; **the script does not run and the request is free** |
| A browser's navigation to a place in the app — `/decks/12` | the document, 200, with `_headers` applied | the edge, the same way |
| Anything else that matches no file — a chunk a deploy renamed, `/sw.js` before step 5.3 | **404**, `text/plain` | the script |
| A navigation that did not say so — `curl -H "Accept: text/html" /decks/12` | the document, 200 | the script, through the binding |

**The third row is the reason there is a script at all.** `not_found_handling:
"single-page-application"` answers every address that matches no file with `index.html` and a 200
— which `/decks/12` needs and `/assets/DeckPage-3f9a.js` must never get. A page loaded before a
deploy asks for its old chunk; handed HTML with a 200 it reports a MIME error instead of the failed
import the app is built to recover from, and a service worker has no reason not to keep the
response. Configuration cannot say "the document for a place, a 404 for a file". With a script
present, Cloudflare's own split does (verified in the docs, below): a request carrying
`Sec-Fetch-Mode: navigate` is answered with the document before any code runs, and every other
miss reaches the script.

**What "a navigation" is differs by who is asking, and both rules are deliberate.** Cloudflare's
is the header a browser sends. The script's, for the clients that send none, is `isNavigation` in
`src/lib/core/web/assets.ts` — a `GET` that accepts `text/html`, for a path whose last segment
has no extension — which is the rule `npm run web:dev` and `web:preview` serve by, imported so the
three cannot come to disagree.

⚠️ **A browser that *navigates* to a missing file gets the document**, by Cloudflare's rule:
typing `/assets/gone.js` into the address bar shows the app. Nothing in the app navigates to a
file, so nothing is handed HTML where it asked for code; it is written down so the probe below
does not read as a bug.

## The policy

`_headers` carries the reason for each line at the line. What is worth knowing before changing it:

- **One Content-Security-Policy, sent with every response — the scripts too.** Measured in
  headless Chrome 154.0.8037.95 on 2026-10-04, against this build with one header changed at a
  time: a dedicated Worker is governed by the policy on **its own script's response**, not the
  page's. With the document's policy stripped of `'wasm-unsafe-eval'` the engine still compiled;
  with the Worker chunk's stripped, it failed with a `CompileError`; with the chunk sent
  `default-src 'none'`, it could not import the engine's glue. With `api.scryfall.com` removed
  from the document's `connect-src` alone the Worker still asked it; removed from every
  response, each request was refused. A service worker is the same: its `fetch` is held to the policy on `sw.js`'s
  response, and a `sw.js` sent with none is held to nothing. So the database Worker's chunk and
  `/sw.js` must carry the policy, and `/*` is how.
- **`connect-src` is exactly the hosts the engine asks**, each read from a constant in
  `crates/grimoire-core` by `hosting.test.ts`, which fails on a missing host *and* on an extra one.
  **Not Mana Pool** (it sends no `Access-Control-Allow-Origin`, so a page cannot read it whatever
  a policy says). **Not the relay**: sync in a browser is phase 6, and that change adds the host
  here in the same commit that adds this origin to the relay's CORS allow-list — until then the
  request fails either way, and a policy that names it is wider for nothing.
- ⚠️ **`data.scryfall.io` is Scryfall's choice, not a constant of ours.** The card sync and both
  tagger feeds download whatever address Scryfall's descriptor names. The desktop follows it
  anywhere; a browser under this policy follows it only to that host. If Scryfall moves its bulk
  files, the web app's first run fails with a policy violation in the console while the desktop
  keeps working — and the fix is one host in `_headers` and a deploy.
- **`img-src` names `cards.scryfall.io` although the page never asks it.** Step 5.3's service
  worker answers a picture on this origin with Scryfall's bytes. Measured the same day: with
  `img-src 'self'` alone, Chrome **blocks** that picture when the service worker hands back
  Scryfall's response as it came — fetched, opaque, or out of Cache Storage, under either key —
  because the check is made against the *response's* address as well. Only a response rebuilt
  from its bytes passed. Naming the host lets 5.3 keep the response it was given.
- **`style-src 'self'`, with the desktop's `style-src-attr 'unsafe-inline'`.** The same
  components run here; `src/CLAUDE.md` has what the first forbids. `hosting.test.ts` holds each
  directive the two hosts share to the desktop's shipped policy, so this one is never the looser.
- **Caching is two rules and a default.** Everything is `no-cache` — kept, and asked about every
  time. `/assets/*` and `/wasm/*` are content-addressed and kept for a year. `/sw.js` restates the
  default by a rule of its own, so loosening `/*` cannot take it along. ⚠️ **A header two matching
  rules both set is joined with a comma**, so each narrower rule detaches first (`! Cache-Control`).
- **No isolation headers.** The OPFS pool needs neither `Cross-Origin-Opener-Policy` nor
  `-Embedder-Policy`, and `require-corp` would refuse every card picture.

**`npm run web:preview` sends the same headers**, read from the built `dist-web/_headers` by
`src/headers.ts`, and answers a missing file with a bare 404 as the script does. The dev server
does not: Vite injects `<style>` elements and talks over a WebSocket, which the policy forbids on
purpose.

### What the browser said under it

Headless Chrome 154.0.8037.95 on Windows 11, 2026-10-04, `npm run web:build` served by
`web:preview` with real hosts made unresolvable. **The engine was not this commit's**: it was a
copy of step 5.2's module as it stood that day, which starts the launch's downloads, under this
commit's page. At **360 × 800** (the phone face) and
**1280 × 800** (the desktop face), each of `/search`, `/collection`, `/decks`, `/wishlist` and
`/settings` loaded as a deep link: **no policy violation on the page or in the Worker, nothing
thrown**, the engine instantiated, and the page's console said `database open in OPFS — journal
delete, corpus journal delete, schema 59` every time. The Worker asked `api.scryfall.com` and
`json.commanderspellbook.com`, and the policy let both leave.

**That zero is not a vacuous one**: the same run with `api.scryfall.com` taken out of
`connect-src` logged a violation for every request the Worker made to it, so a refusal inside
the Worker is something this run can see. **And it is a narrow one**: an empty corpus
on a machine with no network, so no card picture was drawn, no download reached its second host,
and the desktop face showed its *No card data yet* wall rather than a dialog or a menu. No other
browser was run.

## Deploying

⚠️ **No agent runs `wrangler deploy`, or any wrangler command that reaches Cloudflare.** That is
the repo owner's, as it is for the other two Workers. `wrangler` is not a dependency of this
repository; `npx` fetches it.

### Step 0 — ask the host, never a document

`relay/README.md` was wrong twice in one week about what was deployed, and five files once agreed
the relay did not exist while it was answering requests. The only sentence that cannot rot is a
`curl`. **Every answer below is what the configuration *should* give and none has been run** —
there is nothing at the address to ask. Run them before believing this file or its opposite, and
write the answers in here with the date.

```
A=https://mtg-grimoire.app
B=$(ls ../dist-web/wasm)                       # the engine's build id, from the build deployed
J=$(ls ../dist-web/assets | grep -m1 '^index-.*\.js$')
H='^HTTP|content-type|cache-control|content-security-policy|x-content-type|referrer-policy|content-encoding'
```

| # | Probe | Should answer | Answered |
| --- | --- | --- | --- |
| 1 | `curl -s -o /dev/null -D - "$A/" \| grep -iE "$H"` | `200`, `text/html`, `cache-control: no-cache`, `nosniff`, `strict-origin-when-cross-origin`, and the policy — **byte for byte the line in `_headers`** | **not yet run** |
| 2 | `curl -s -o /dev/null -w "%{http_code} %{content_type}\n" -H "Sec-Fetch-Mode: navigate" "$A/decks/12"` | `200 text/html` — the edge, the script not run | **not yet run** |
| 3 | `curl -s -w " %{http_code} %{content_type}\n" "$A/decks/12"` | `Not found 404 text/plain; charset=utf-8` — curl accepts `*/*`, so the script refuses it | **not yet run** |
| 4 | `curl -s -o /dev/null -D - -H "Accept: text/html" "$A/decks/12" \| grep -iE "$H"` | `200`, `text/html` — the script, through the binding. **Whether the policy is on this one is open** (below) | **not yet run** |
| 5 | `curl -s -w " %{http_code} %{content_type}\n" "$A/assets/nope.js"` | `Not found 404 text/plain; charset=utf-8`. ⚠️ **`200 text/html` here means the script is not deployed** and every renamed chunk is being answered with the document | **not yet run** |
| 6 | `curl -s -o /dev/null -w "%{http_code} %{content_type}\n" -H "Sec-Fetch-Mode: navigate" "$A/assets/nope.js"` | `200 text/html` — Cloudflare's rule for a navigation, harmless | **not yet run** |
| 7 | `curl -s -o /dev/null -D - "$A/wasm/$B/grimoire_web_bg.wasm" \| grep -iE "$H"` | `200`, **`application/wasm`**, `public, max-age=31536000, immutable`, and the policy | **not yet run** |
| 8 | the same with `-H "Accept-Encoding: br, gzip"` | a `content-encoding` — `application/wasm` is on Cloudflare's default list. **Record which**: it is the size a reader downloads | **not yet run** |
| 9 | `curl -s -o /dev/null -D - "$A/assets/$J" \| grep -iE "$H"` | `200`, `text/javascript`, a year, immutable — and **not** `no-cache, public, …`, which is the detach not working | **not yet run** |
| 10 | `curl -s -o /dev/null -w "%{http_code}\n" "$A/sw.js"` | `404` until step 5.3 ships the file; then `200` with `cache-control: no-cache` | **not yet run** |
| 11 | `curl -s -o /dev/null -w "%{http_code}\n" "$A/_headers"` | `404` — the file is parsed, not served | **not yet run** |
| 12 | `curl -s -o /dev/null -w "%{http_code}\n" https://mtg-grimoire-app.denmark-east.workers.dev/` | **not `200`** — there is no second origin | **not yet run** |
| 13 | `curl -sI http://mtg-grimoire.app/ \| head -3` | a redirect to `https`, if the zone has *Always Use HTTPS* on. A browser never asks: `.app` is HSTS-preloaded | **not yet run** |

Then open the address in a browser with its console open: no policy violation, the app past its
gate, and `database open in OPFS` on the console. That is the probe no `curl` can make.

### The steps, in order

1. **`npm ci`**, on Node from `.nvmrc`.
2. **`npm run web:wasm`** — the engine, into `dist-wasm/`. It needs the `wasm32-unknown-unknown`
   target, **clang 18 or newer** (the SQLite shim is C23; on Windows the script looks in the LLVM
   installer's folder), and a **`wasm-bindgen` CLI of exactly the version `Cargo.lock` resolves**
   — `cargo install wasm-bindgen-cli --version <that> --locked`. The script checks all three and
   says which is wrong.
3. **`npm run web:build`** — the page, into `dist-web/`, with the engine under `wasm/<build id>/`
   and `_headers` at its root. ⚠️ **`wrangler deploy` uploads whatever is in `dist-web/`**: the
   last build on this machine, not this commit. Build from the commit being deployed, with a clean
   tree, and check `dist-web/_headers` is there — a `dist-web/` built before step 5.5 has none,
   and deploys as an app with no policy and no caching rules.
4. **`npm run web:smoke`**, then **`npm run web:preview`** and a look in a real browser. The
   preview is the last place the policy can be met before a reader meets it.
5. **`cd app-worker && npx wrangler deploy`.** Read what it prints: how many header rules it
   parsed — every rule in `_headers`, or one was refused — the files it uploaded, and the custom
   domain it attached. The first deploy
   creates the DNS record and the certificate for `mtg-grimoire.app`; ⚠️ a Custom Domain cannot be
   created over a hostname that already has a CNAME record, so a parking record on the apex has
   to go first. The certificate can take some minutes.
6. **Step 0's probes, all of them**, and the answers written into the table above with the date.

### What a deploy changes for a reader

- **Every deploy renames the chunks that changed.** A page already open keeps running on what it
  loaded, and its next lazy import of a renamed chunk is a 404 — which the app has to recover
  from. That recovery, and the bar that offers the new version, are step 5.3's; until it ships, a
  reader who navigates inside an open app across a deploy can meet a face that fails to load, and
  a reload cures it.
- **The engine keeps its address across a deploy that did not change it.** Its directory is a
  hash of its own bytes, so a deploy of the page alone does not make anybody download the module
  again.
- **The origin is the app's identity and must never move.** A browser keys both OPFS databases,
  the service worker and the install to it. Served from another host, another subdomain or `www`,
  a reader's collection is not there — it is still in their browser, under the address they can no
  longer reach. For the same reason `www.mtg-grimoire.app`, if it is ever wanted, is a **redirect
  rule on the zone** to the apex and never a second Custom Domain on this Worker.
- **Phase 6 depends on this exact string.** The relay's CORS allow-list will name
  `https://mtg-grimoire.app`, and `_headers` will name the relay.

### Rolling back

`npx wrangler rollback` from this directory makes the previous version the deployment; `npx
wrangler versions list` shows what there is to go back to (the 100 most recent). **To a reader a
rollback is another deploy**: the chunk names change again, and a page opened on the bad build
meets the same 404 on its next lazy import.

**It does not roll back a reader's data.** If a build migrated a schema in OPFS, the build before
it is now looking at a database from its future. A page-only fault is safe to roll back; a build
that shipped a schema rung is fixed forwards.

### What only a real deploy can settle

- **Every row of the probe table.** None has been run.
- **Whether `_headers` reaches a response the script fetched through the binding** (probe 4). The
  docs say the file is "not applied to responses generated by your Worker code"; whether an asset
  the script *asked for* counts is not said. Either answer is safe — the only clients on that path
  send no Fetch Metadata, which no browser that can run the app does — but it should be known.
- **That the navigation split is as the docs describe** (probes 2, 5 and 6): the document at the
  edge for a navigation, the script for every other miss. Probe 5 is the one that matters.
- **The `Content-Type` of the module** (probe 7). The docs say only that wrangler takes it from
  the extension. `WebAssembly.instantiateStreaming` refuses anything but `application/wasm`.
- **What the edge compresses the module with** (probe 8), and so what a first visit downloads.
  The module built on 2026-10-04 was 8,592,080 bytes, and 3.06 MB gzipped by Vite's report.
- **That the detach works as written** (probe 9), and that `no-cache` *replaces* Cloudflare's own
  default `Cache-Control` rather than joining it.
- **How long the certificate takes**, and whether the apex had a record in the way.
- **That a rollback brings a version's files back with it.** The limits are stated per Worker
  version, which says so; nobody here has watched it.
- **Any browser but one Chrome on Windows, and any phone.** The policy has met no Safari and no
  Firefox, and neither has the engine.
- **The policy against real traffic**: a card picture through a service worker (5.3), a download
  that follows the descriptor to `data.scryfall.io`, Card Kingdom's pricelist.

## Cost

Read from Cloudflare's documentation on 2026-10-04; none of it measured here.

- **A request for a file is free and unlimited, on the free plan too** — "Requests to static
  assets are free and unlimited" (`workers/platform/pricing`,
  `workers/static-assets/billing-and-limitations`). That is every chunk, every icon, both halves
  of the engine, and — with the script and the compatibility date this configuration has — the
  document for every navigation.
- **A request the script answers is a Worker request**, from the account's **100,000 a day** on
  the free plan (`workers/platform/limits`). ⚠️ **That is the same budget the relay's sync
  spends**, the cliff `relay/README.md` describes: past it every reader's sync errors at once.
  What reaches the script is a miss that is not a browser's navigation — a renamed chunk asked for
  by a page that predates a deploy, `/sw.js` until 5.3, a crawler. In ordinary use that is a
  handful per reader per deploy.
- **A flood of misses is the exposure**, and unlike the two `workers.dev` Workers this one sits
  behind a zone: a rate-limiting rule on `mtg-grimoire.app` can refuse a caller *before* the Worker
  is invoked, which `relay/src/ratelimit.ts` could not do for the relay. **None is configured.**
  It is the first thing to add if the relay's 70% notification ever fires for this Worker's sake.
- **Nothing here is `run_worker_first`, and that is what keeps the app up on a bad day.** The
  billing page: "If you exceed your free tier request limits, these requests will receive a 429
  (Too Many Requests) response instead of falling back to static asset serving" — said of
  `run_worker_first`, which this is not. ⚠️ **Read the other way, that sentence says what this
  Worker does once the account's day is spent: a miss falls back to asset serving, which under
  the single-page fallback is the document again.** So on the one day the budget runs out, a
  renamed chunk is answered with HTML after all. That is an inference from one sentence and has
  not been seen; the day it matters, sync is already down.
- **Limits**: 20,000 files and 25 MiB a file per version on the free plan
  (`workers/platform/limits`); the module, the build's largest file, is a third of that.
  `_headers` allows 100 rules and 2,000 characters a line (same page); the file is well inside
  both, and `src/headers.ts` refuses one that is not.
- **No storage, no cron trigger, no secret.** This Worker adds nothing to the account's five
  triggers and nothing to D1's or R2's counters.

## The configuration, key by key

Each verified against Cloudflare's documentation on 2026-10-04.

| Key | Value | Where it is documented |
| --- | --- | --- |
| `main` | `src/index.ts` | `workers/static-assets/` — "If no matching asset is found and a Worker script is present, the request will be processed by the Worker" |
| `compatibility_date` | `2026-08-27`, the relay's | `workers/configuration/compatibility-flags/` — `assets_navigation_prefers_asset_serving` is the default from `2025-04-01` |
| `routes[].custom_domain` | `mtg-grimoire.app` | `workers/configuration/routing/custom-domains/` — the apex form is the page's own example; DNS and certificate are created by the deploy |
| `workers_dev`, `preview_urls` | `false`, `false` | `workers/versions-and-deployments/version-urls/` — "If `preview_urls` is omitted, Wrangler does not change an existing Version URL setting" |
| `assets.directory` | `../dist-web` | `workers/static-assets/binding/` |
| `assets.binding` | `ASSETS` | `workers/wrangler/configuration/` — "only useful when a Worker script is set with `main`" |
| `assets.not_found_handling` | `single-page-application` | `workers/static-assets/routing/single-page-application/` — with a script, "*navigation requests* will not invoke the Worker script" |
| `observability` | `{ "enabled": true }` | as the other two Workers |

`html_handling` is left at its default, `auto-trailing-slash`: `/index.html` redirects to `/`, and
nothing in the build is another HTML file.

## Testing

No workerd in this tree, for the reason `share-worker/README.md` gives. The script is a plain
function over an injected `Env`, driven as `worker.fetch(request, env)` against a fake of the
assets binding **that answers a missing path with the document, as the real one does** — so a
script that deferred a missing chunk to the binding fails there.

```
npx vitest run app-worker/
npx tsc -p tsconfig.app-worker.json
```

`app-worker/src/**/*.test.ts` is a glob in `vite.config.ts`; a directory that list does not name
is collected by nothing. `scripts/ci-route.mjs` routes this directory to `frontend`, which runs
all of the above, and to `web`, whose build copies `_headers` and loads `src/headers.ts`.
