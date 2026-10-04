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
- **There is nothing to set with `wrangler secret put`**, and no `.dev.vars` belongs here. What
  keeps one — or wrangler's `.wrangler/` state — out of a commit is the root `.gitignore`, which
  ignores both everywhere; `hosting.test.ts` sweeps this directory's dotfiles too, but it can
  only see one on the machine that has it.
- **The Cloudflare account id is in no file of this repository** — wrangler takes it from the
  login — and `hosting.test.ts` fails if anything shaped like one appears in this directory.

## What it answers

| Request | Answer | Who answers |
| --- | --- | --- |
| A file that exists — `/`, `/assets/…`, `/wasm/<build>/…`, the manifest, `/sw.js` | the file, with `_headers` applied | the edge; **the script does not run and the request is free** |
| A browser's navigation to a place in the app — `/decks/12` | the document, 200, with `_headers` applied | the edge, the same way |
| Anything else that matches no file — a chunk a deploy renamed | **404**, `text/plain`, `no-store` | the script |
| A card picture, `/mtgimg/…`, from a page no service worker controls yet | **404**, `no-store` — whatever the caller accepts | the script |
| A navigation that did not say so — `curl -H "Accept: text/html" /decks/12` | the document, 200, with `_headers` applied | the script, through the binding |
| `/_headers` itself | **404** — the file is parsed, not served | the script |

**Where "the script" answers, the answer depends on the account's day.** Once the free plan's
100,000 Worker requests are spent, Cloudflare answers every request it would have handed to the
script with a `429 text/html` of its own — *Cost*, below, has the source. A file that exists and
a browser's navigation are untouched.

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

**Three trees hold no place at all**: under `/assets/`, `/wasm/` and `/mtgimg/` the script
answers a miss with the 404 whatever the caller accepts. The third is step 5.3's: card pictures
are asked of this origin at `/mtgimg/…` and answered by the service worker, so a page that worker
does not control yet asks the network — and the document there would be drawn as a broken picture,
with a 200 a cache has no reason to refuse. An `<img>`'s request is `Sec-Fetch-Mode: no-cors`, so
the edge never gives it the fallback; the tree is named in the script so that the script cannot
either, for a path whose last segment happens to have no extension.

⚠️ **A browser that *navigates* to a missing file gets the document**, by Cloudflare's rule:
typing `/assets/gone.js`, `/mtgimg/display/abc/0` or `/_headers` into the address bar shows the
app. Nothing in the app navigates to a file or a picture, so nothing is handed HTML where it asked
for code or pixels; it is written down so the probe below does not read as a bug. **Under
`/assets/` and `/wasm/` that document is sent with the tree's own caching** — `_headers` is
matched on the address asked, so it is the app's HTML marked `immutable` for a year at an address
nothing links to. Harmless, and odd enough to be worth knowing before it is seen in a cache.
**The one setting that could close all of this is not taken**: `run_worker_first` with a list of
patterns "disables the automatic `Sec-Fetch-Mode: navigate` detection" (the
single-page-application page) — in the asset worker's source, a list makes `canFetch` keep the
fallback for *every* request, so a missing chunk would be answered with the document again — and
a request it matches is a 429 once the free plan's day is spent.

## The policy

`_headers` carries the reason for each line at the line. What is worth knowing before changing it:

- **One Content-Security-Policy, sent with every response — the scripts too.** Measured in
  headless Chrome 154.0.8037.95 on 2026-10-04, against this build with one header changed at a
  time: a dedicated Worker is governed by the policy on **its own script's response**, not the
  page's. With the document's policy stripped of `'wasm-unsafe-eval'` the engine still compiled;
  with the Worker chunk's stripped, it failed with a `CompileError`; with the chunk sent
  `default-src 'none'`, it could not import the engine's glue. With `api.scryfall.com` removed
  from the document's `connect-src` alone the Worker still asked it; removed from every
  response, each request was refused. A service worker is the same: its `fetch` is held to the
  policy on `sw.js`'s response, and a `sw.js` sent with none is held to nothing. So the database
  Worker's chunk and `/sw.js` must carry the policy, and `/*` is how.
- ⚠️ **So a change of policy has to reach the Worker's script, and one hashed file is therefore
  not `immutable`.** `assets/worker-<hash>.js` is content-addressed like its neighbours, but the
  policy it runs under is this file's, not its own bytes'. A deploy that changes only `_headers`
  renames nothing — and measured, in the same Chrome, with a Worker script whose address and
  bytes stay put while the server changes the policy sent with it:

  | The script's `Cache-Control` | On the next visit | The Worker runs under |
  | --- | --- | --- |
  | a year, `immutable` | not requested at all | **the old policy** |
  | `no-cache`, and the 304 carries the new policy | a conditional request | the new policy |
  | `no-cache`, and the 304 carries no policy | a conditional request | the old policy |

  So the chunk has a rule of its own, after `/assets/*`: `no-cache`. It is a few kilobytes and
  answers 304, and Cloudflare's 304 carries `_headers` — `handleRequest` in the asset worker's
  source wraps every response it returns, the `NotModifiedResponse` included, in
  `attachCustomHeaders`. Without the rule, "one host in `_headers` and a deploy" would have fixed
  new visitors and nobody who had been before; phase 6 adding the relay is the same trap. The
  rule is written for the name Vite gives the chunk, and `hosting.test.ts` reads the line that
  constructs the Worker so a renamed file is a failure there. **The service worker is a second
  cache with the same property** (step 5.3): it serves the shell, this chunk included, out of
  Cache Storage with the headers it was stored with. That step re-fetches the shell per build and
  hashes `_headers` into its build id, so a policy change is a new build to it — a property of
  that step, pinned by a test there (`src/lib/core/web/sw/shell.test.ts`, *moves when only the
  host's `_headers` changed*), and not something this directory relies on or checks.
- **`connect-src` is exactly the hosts the engine asks, and `hosting.test.ts` holds it there in
  two halves.** *A host that moved*: the engine's addresses are read by name — `SCRYFALL_API`,
  `IMAGE_HOST`, `FEED_URL` and Card Kingdom's `url()` — and the policy is held set-equal to
  their hosts and the bulk files', so a missing entry and an extra one are both red. *A host that is new*: a census of every
  `https://` literal in the code the three crates **ship** (above each file's test modules, by
  the cut `crates/grimoire-core/CLAUDE.md` states; comments out), each of which must be in
  `connect-src` or on a short list of hosts a browser's engine never asks, with a reason apiece —
  Mana Pool, the relay until phase 6, Patreon's authorize page, the repository's address in the
  `User-Agent`, the scanner's debug page. A sixth feed in a file the test has never heard of is
  red. **Not Mana Pool** (it sends no `Access-Control-Allow-Origin`, so a page cannot read it
  whatever a policy says). **Not the relay**: sync in a browser is phase 6, and that change adds
  the host here in the same commit that adds this origin to the relay's CORS allow-list — until
  then the request fails either way, and a policy that names it is wider for nothing.
- ⚠️ **What the fence cannot hold: `data.scryfall.io`, which is Scryfall's choice and no line
  of ours.** The card sync and both Tagger feeds download whatever address Scryfall's descriptor
  names; no shipped line says the host, and the census has a test saying so. The fence reads it
  from descriptors transcribed into two *test* modules, which pins the policy to what Scryfall
  sent on the day those were written. The desktop follows the descriptor anywhere; a browser
  under this policy follows it only to that host. If Scryfall moves its bulk files, every suite
  stays green and the web app's first run fails — the page says `http request failed: error
  sending request`, the console has the violation — while the desktop keeps working. The fix is
  one host in `_headers` and a deploy, and the rule above is what makes that deploy reach a
  reader who has been before. The same is true of any address that is built, configured or sent
  rather than written.
- **`img-src` is this origin and `data:`, and does not name `cards.scryfall.io`** — though every
  card picture comes from there. Step 5.3's service worker answers a picture at `/mtgimg/…` with
  Scryfall's bytes, and **it has to hand back a response rebuilt from those bytes**. Measured the
  same day, on two `localhost` origins: with `img-src 'self'` alone, Chrome **blocks** the picture
  when the service worker returns Scryfall's response as it came — fetched, opaque, or out of
  Cache Storage, under either key — because the check is made against the *response's* address as
  well as the one the page asked. Only `new Response(bytes)` was drawn. That is what 5.3 builds, so
  the host stays out: the policy is tighter, and a service worker that ever stops rebuilding goes
  wrong where it can be seen. It is in `connect-src`, which is what that worker's `fetch` needs.
  (The first commit of this file named the host in `img-src`, before 5.3 was built to rebuild.)
- **`style-src 'self'`, with the desktop's `style-src-attr 'unsafe-inline'`.** The same
  components run here; `src/CLAUDE.md` has what the first forbids. `hosting.test.ts` holds each
  directive the two hosts share to the desktop's shipped policy, so this one is never the looser.
- **Caching is a default, two trees, and two files.** Everything is `no-cache` — kept, and asked
  about every time: the document, the manifest, the favicon and the manifest's `icons/*.png`,
  whose names carry no hash, so a year for them would be a year an installed app kept an old
  icon. `/assets/*` and `/wasm/*` are content-addressed and kept for a year — less the engine's
  Worker, above. `/sw.js` restates the default by a rule of its own, so loosening `/*` cannot
  take it along. ⚠️ **A header two matching rules both set is joined with a comma**, so each
  narrower rule detaches first (`! Cache-Control`); and **two rules for one path are not two
  rules** — Cloudflare stores them by path and keeps the last — so `src/headers.ts` refuses a
  file that repeats one, and a rule with nothing under it.
- **No isolation headers.** The OPFS pool needs neither `Cross-Origin-Opener-Policy` nor
  `-Embedder-Policy`, and `require-corp` would refuse every card picture.

**`npm run web:preview` sends the same headers**, read from the built `dist-web/_headers` by
`src/headers.ts`, answers a missing file with a bare 404 as the script does, and answers
`/_headers` itself with a 404, as the host does. The dev server sends none of it: Vite injects
`<style>` elements and talks over a WebSocket, which the policy forbids on purpose.

### What the browser said under it

Headless Chrome 154.0.8037.95 on Windows 11, 2026-10-04, over `npm run web:build` of `main` at
`92cbc02b` with this directory merged in. **The module was a copy, not this tree's own build**:
8,623,589 bytes, taken from the phase's working tree that day (3.07 MB gzipped by Vite's
report).

- **A first run, under the policy.** A scratch copy of `scripts/web-smoke.mjs` that serves
  `dist-web/` through `headersFor` and listens for violations on the page and in the Worker —
  the repository's script does neither. All nine of its checks passed: the engine compiled and
  opened its database, the card sync asked `api.scryfall.com` and followed the descriptor to
  `data.scryfall.io`, both Tagger files and the combos finished with rows stored, a typed search
  drew a tile, Settings downloaded Card Kingdom's pricelist, a reload kept the cards, a second
  tab was told. **Every host in `connect-src` was asked and let through.**
- **The one violation, seventeen times: `img-src` refusing `http://mtgimg.localhost/…`.** On
  `main` the page still names the desktop's image protocol; step 5.3 moves pictures to
  `/mtgimg/…` on this origin. Until it lands, a card picture in a browser is blocked by this
  policy where before it was a connection nobody accepted — the tile draws its retry either way.
  (**True of the tree that run was made on.** Step 5.3 has since landed beside this directory:
  the page asks `/mtgimg/…` and the service worker answers. That run has not been made again, so
  no card picture has yet been seen drawn under this policy.)
- **That count is not a vacuous one.** The same run with `data.scryfall.io` taken out of
  `connect-src` failed at the card sync — the page said `http request failed: error sending
  request` — and reported the Worker's three refused downloads by name. That sentence is also
  what a reader sees on the day Scryfall moves its bulk files.
- **Both faces, as deep links**, through `npm run web:preview` with real hosts unresolvable: at
  360 × 800 and 1280 × 800, each of `/search`, `/collection`, `/decks`, `/wishlist` and
  `/settings` reached its shell with no violation and nothing thrown, and the console said
  `database open in OPFS — journal delete, corpus journal delete, schema 59` every time.

**What stayed unexercised**: the desktop face over a corpus — the fixtures drive the phone face,
and at 1280 the empty database shows its *No card data yet* wall rather than a table, a dialog or
a menu; a card picture actually drawn; a service worker; any browser but this one.

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
W=$(ls ../dist-web/assets | grep -m1 '^worker-.*\.js$')   # the engine's Worker
H='^HTTP|content-type|cache-control|content-security-policy|x-content-type|referrer-policy|content-encoding|^etag'
```

| # | Probe | Should answer | Answered |
| --- | --- | --- | --- |
| 1 | `curl -s -o /dev/null -D - "$A/" \| grep -iE "$H"` | `200`, `text/html`, `cache-control: no-cache`, `nosniff`, `strict-origin-when-cross-origin`, and the policy — **byte for byte the line in `_headers`** | **not yet run** |
| 2 | `curl -s -o /dev/null -D - -H "Sec-Fetch-Mode: navigate" "$A/decks/12" \| grep -iE "$H"` | `200`, `text/html`, **and the same policy line and `cache-control: no-cache`** — the fallback document, answered at the edge with the script not run. This is the document every deep link and every reload of one gets; a policy on `/` alone would not be a policy | **not yet run** |
| 3 | `curl -s -w " %{http_code} %{content_type}\n" "$A/decks/12"` | `Not found 404 text/plain; charset=utf-8` — curl accepts `*/*`, so the script refuses it | **not yet run** |
| 4 | `curl -s -o /dev/null -D - -H "Accept: text/html" "$A/decks/12" \| grep -iE "$H"` | `200`, `text/html`, the policy and `no-cache` — the script, through the binding. The docs do not say `_headers` reaches this one; the asset worker's source does (`attachCustomHeaders` wraps every response, matched on the path the script asked — `/`) | **not yet run** |
| 5 | `curl -s -w " %{http_code} %{content_type}\n" "$A/assets/nope.js"` | `Not found 404 text/plain; charset=utf-8`. ⚠️ **`200 text/html` here means the script is not deployed** and every renamed chunk is being answered with the document | **not yet run** |
| 6 | `curl -s -o /dev/null -w "%{http_code} %{content_type}\n" -H "Sec-Fetch-Mode: navigate" "$A/assets/nope.js"` | `200 text/html` — Cloudflare's rule for a navigation, harmless | **not yet run** |
| 7 | `curl -s -o /dev/null -D - "$A/wasm/$B/grimoire_web_bg.wasm" \| grep -iE "$H"` | `200`, **`application/wasm`**, `public, max-age=31536000, immutable`, and the policy | **not yet run** |
| 8 | the same with `-H "Accept-Encoding: br, gzip"` | a `content-encoding` — `application/wasm` is on Cloudflare's default list. **Record which**: it is the size a reader downloads | **not yet run** |
| 9 | `curl -s -o /dev/null -D - "$A/assets/$J" \| grep -iE "$H"` | `200`, a JavaScript MIME type (wrangler's table says `application/javascript`; the preview says `text/javascript`; a browser takes either), a year, immutable — and **not** `no-cache, public, …`, which is the detach not working | **not yet run** |
| 10 | `curl -s -o /dev/null -D - "$A/sw.js" \| grep -iE "$H"` | `200`, a JavaScript MIME type, **`cache-control: no-cache`** — one value — and the policy: the service worker's own `fetch` of a card picture is held to the line on *this* response. ⚠️ `404` means the build deployed has no service worker (`web:build` writes `sw.js` last) | **not yet run** |
| 11 | `curl -s -o /dev/null -w "%{http_code}\n" "$A/_headers"` | `404` — the file is parsed, not served, which is why a service worker's precache list must leave it out | **not yet run** |
| 12 | `curl -s -o /dev/null -w "%{http_code}\n" https://mtg-grimoire-app.denmark-east.workers.dev/` | **not `200`** — there is no second origin | **not yet run** |
| 13 | `curl -sI http://mtg-grimoire.app/ \| head -3` | a redirect to `https`, if the zone has *Always Use HTTPS* on. A browser never asks: `.app` is HSTS-preloaded | **not yet run** |
| 14 | `curl -s -o /dev/null -D - -H "Sec-Fetch-Mode: no-cors" -H "Accept: image/avif,image/webp,image/*,*/*;q=0.8" "$A/mtgimg/display/abc/0" \| grep -iE "$H"` | `404`, `text/plain`, **`cache-control: no-store`** — an `<img>`'s request, as a page no service worker controls makes it. ⚠️ `200 text/html` is the document where a picture was asked | **not yet run** |
| 15 | the same with `-H "Accept: text/html"` and no `Sec-Fetch-Mode` | `404` again — the script holds no place under `/mtgimg/` | **not yet run** |
| 16 | `curl -s -o /dev/null -D - "$A/icons/icon-192.png" \| grep -iE "$H"` | `200`, `image/png`, `cache-control: no-cache` | **not yet run** |
| 17 | `curl -s -o /dev/null -D - "$A/assets/$W" \| grep -iE "$H"` | `200`, a JavaScript MIME type, **`cache-control: no-cache`** — one value, not a year and not three joined — the policy, and an `etag` | **not yet run** |
| 18 | `E=$(curl -s -o /dev/null -D - "$A/assets/$W" \| grep -i '^etag' \| cut -d' ' -f2 \| tr -d '\r')`, then `curl -s -o /dev/null -D - -H "If-None-Match: $E" "$A/assets/$W" \| grep -iE "$H"` | **`304`, with the policy line on it.** This is the response that re-governs a returning reader's engine after a change to `_headers`; a 304 without the policy leaves the old one in force (measured) | **not yet run** |

Then open the address in a browser with its console open: no policy violation, the app past its
gate, and `database open in OPFS` on the console. That is the probe no `curl` can make. ⚠️ **Look
at the document's source while there**: a `<script>` the build did not write is a zone feature
rewriting the page — *Before the first deploy*, below.

**On a day the account's free limit is spent, probes 3–5, 11, 14 and 15 answer `429 text/html`**
— Cloudflare's own page, not the script's 404 — and the rest are unchanged. *Cost* has why.

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
   preview applies the policy by this repository's own reading of `_headers`.
5. **`cd app-worker && npx wrangler dev`, and the probes against it — before anything is
   public.** `wrangler dev` runs Cloudflare's own asset worker and router worker locally, the
   code `workers-sdk` publishes and the edge runs, over this `wrangler.jsonc` and this
   `dist-web/`, and deploys nothing. Set `A=http://localhost:8787` (wrangler's default port) and
   run the table: it answers **the navigation split (2, 3, 5, 6, 14, 15), the headers on the
   fallback document and on the one the script fetches (2, 4), the detach and the one-value
   `Cache-Control` (7, 9, 17), the 304 that carries the policy (18), `/_headers` (11), `/sw.js`
   (10) and the content types (7, 9, 16)** — every question about how *Cloudflare's code* reads
   this configuration, which `web:preview` can only answer in this repository's own words.
   ⚠️ **This step matters more here than for the other two Workers**: with both alternate
   origins off there is no `workers.dev` address to look at first, so the first deploy is live
   on the apex the moment it finishes. **Not run by anybody yet** — `wrangler` is not installed
   in this repository and no agent may add or run it. If it asks to log in, it is not in local
   mode: stop.
6. **Before the first deploy, look at the zone** — *Before the first deploy*, below.
7. **`npx wrangler deploy`**, from `app-worker/`. Read what it prints: how many header rules it
   parsed — every rule in `_headers`, or one was refused — the files it uploaded, and the custom
   domain it attached. The first deploy creates the DNS record and the certificate for
   `mtg-grimoire.app`; ⚠️ a Custom Domain cannot be created over a hostname that already has a
   CNAME record, so a parking record on the apex has to go first. The certificate can take some
   minutes.
8. **Step 0's probes, all of them, against the real address**, and the answers written into the
   table above with the date.

⚠️ **Never `npx wrangler preview` for this Worker.** A Preview is the same bundle deployed at
another address, and any second origin is a second, empty OPFS that looks like the app.
Cloudflare's Previews pages say a Preview's `workers.dev` address is governed by `preview_urls`,
which is `false` here; the review of this directory read it as *not* governed. Nobody has run it,
and a reader's collection is not the thing to find out with.

### Before the first deploy: what the zone may do to the page

The policy is `script-src 'self'`, and a Cloudflare zone has features that **rewrite proxied
HTML** to add a script of their own. Each would be refused by the policy on every load — a
console error a reader never sees and a feature that silently does nothing — or, worse, would be
"fixed" by loosening the policy. **Nobody writing this has seen the zone**; these are the ones
the documentation names, each to be confirmed **off** for `mtg-grimoire.app` before the first
deploy:

| Feature | What it does to the page | Where the docs put it |
| --- | --- | --- |
| **Web Analytics, automatic setup** | injects `<script src="https://static.cloudflareinsights.com/beacon.min.js">` into every proxied page of the zone | `web-analytics/` — the dashboard's Web Analytics section, *Manage Site* for the hostname. ⚠️ Its *exclude EU visitors* option means an owner in Denmark may never be served the script that every reader outside the EU is — check the setting, not the page |
| **Rocket Loader** | rewrites `<script>` tags and adds its own loader | `speed/optimization/content/rocket-loader/` — "If you have a Content Security Policy … you will need to update your headers" |
| **Email Address Obfuscation** | rewrites e-mail addresses it finds in the HTML — idle while the document has none, which is today | named beside Rocket Loader on that page as using non-standard tags |
| **JavaScript Detections** (bot settings) | injects an **inline** script; the docs quote the console error `script-src 'self'` produces. It also strips the `ETag` from HTML it touches | `cloudflare-challenges/challenge-types/javascript-detections/` |

None of them is turned on by anything in this repository; each is a setting of the zone. **The check that cannot be fooled** is the document a reader gets: `curl -s
-H "Sec-Fetch-Mode: navigate" https://mtg-grimoire.app/ | diff - ../dist-web/index.html` — from
outside the EU as well, if Web Analytics was ever on — must print nothing.

### What a deploy changes for a reader

- **Every deploy renames the chunks that changed.** A page already open keeps running on what it
  loaded, and its next lazy import of a renamed chunk is a 404 — which the app has to recover
  from. Step 5.3's service worker takes that case away rather than recovering from it: a page it
  controls is served its own build, whole, out of a cache named for that build for as long as the
  page is open, and a bar offers the new version, which only the reader's press activates
  (light-app.md §9.3). A page no worker controls — a browser with none, or one that evicted the
  cache under a live page — can still meet a face that fails to load across a deploy, and a
  reload cures it.
- **The engine keeps its address across a deploy that did not change it.** Its directory is a
  hash of its own bytes, so a deploy of the page alone does not make anybody download the module
  again.
- **A deploy that changes only `_headers` renames nothing, and still reaches a reader who has
  been before** — through the two responses a policy is read from, both `no-cache`: the document,
  and the engine's Worker chunk, whose 304 carries the new line. From 5.3 on it must also get
  past the service worker, which that step arranges by hashing `_headers` into its build id.
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

### What is settled, what `wrangler dev` settles, and what only a deploy can

**Nothing in the probe table has been run, anywhere.** But the questions are not all the same
kind, and most of them do not need a public address.

**Read off Cloudflare's own source** (`cloudflare/workers-sdk`, `packages/workers-shared`, at
`f025bbfd`, 2026-10-03) — the asset worker and the router worker that `wrangler dev` runs
locally and Cloudflare runs in front of a Worker with assets. Read, not run:

- **`_headers` reaches the fallback document and a document the script fetched through the
  binding.** `handleRequest` (asset-worker) wraps *every* response it returns in
  `attachCustomHeaders`, matched on the path of the request it was given — the 200, the
  single-page fallback, the 304.
- **The navigation split.** `canFetch` keeps `not_found_handling` only when the request carries
  `Sec-Fetch-Mode: navigate` (and the flag is on); for every other request a miss is "no asset",
  and the router sends it to the script.
- **Detach, then set, yields one value**; rules apply in the file's order; two rules for one
  path are one rule, the last (`constructHeaders` stores them by path); a rule with nothing
  under it is dropped.

**Step 5, `wrangler dev`, turns each of those from read to run** — the navigation split, the
headers on both documents, the detach, the Worker chunk's 304, `/_headers`, the content types —
with nothing public.

**Only a deploy** can settle these:

- **The certificate and the apex**: how long issuance takes, and whether a record was in the way.
- **What the edge compresses the module with** (probe 8), and so what a first visit downloads.
  The module this was checked against was 8,623,589 bytes, and 3.07 MB gzipped by Vite's report.
- **That neither alternate origin answers** (probe 12), and what the zone does to plain `http`
  (probe 13).
- **What the zone's own features do to the document** — the table above.
- **That a rollback brings a version's files back with it.** The limits are stated per Worker
  version, which says so; nobody here has watched it.
- **The policy against the real hosts, from this origin.** Every host in `connect-src` has been
  asked under it and answered from a fixture; none has been asked for real from a page at
  `mtg-grimoire.app`, where the CORS answers are the hosts' own.

**And neither can settle these**, which are a browser's and a later step's: any browser but one
Chrome on Windows, and any phone — the policy has met no Safari and no Firefox, and neither has
the engine; and a card picture through the service worker (5.3 — built since, and not yet driven
in a browser under this policy), which is the one thing `img-src` has yet to draw.

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
  by a page that predates a deploy, a crawler. In ordinary use that is a
  handful per reader per deploy. ⚠️ **And, from 5.3 on, every card picture a page asks before its
  service worker controls it**: each `/mtgimg/…` that reaches the network is one Worker request
  for a 404. A first visit that draws a wall of cards ahead of the worker taking control spends
  one per tile, so how soon that worker claims its page is a cost on this budget, not only a
  matter of broken pictures. Nobody has counted it.
- **A flood of misses is the exposure**, and unlike the two `workers.dev` Workers this one sits
  behind a zone: a rate-limiting rule on `mtg-grimoire.app` can refuse a caller *before* the Worker
  is invoked, which `relay/src/ratelimit.ts` could not do for the relay. **None is configured.**
  It is the first thing to add if the relay's 70% notification ever fires for this Worker's sake.
- **What a spent day does, and does not do.** In the router's source
  (`router-worker/src/worker.ts`, `routeToUserWorker`), once the free limit is exhausted —
  `eyeballConfig.limitedAssetsOnly` — **every** dispatch to the script is answered instead with
  `429`, `Content-Type: text/html`, Cloudflare's own page. The path taken when no asset matched
  goes through that function exactly as a `run_worker_first` one does; the billing page's
  sentence about `run_worker_first` ("these requests will receive a 429 … instead of falling
  back to static asset serving") is true of it and is not a contrast with the rest. So on that
  day: **a renamed chunk, a `/mtgimg/…` miss, `/_headers` and a `curl`-style deep link are each
  a `429 text/html`** — not the document with a 200, and not the script's 404 either. **A file
  that exists and a browser's navigation are untouched**: `routeToAssets` is not behind the
  check, which is what not being `run_worker_first` buys — the app still loads and deep links
  still open on the day sync is down. (This paragraph read the billing sentence backwards for
  two commits and concluded a miss would fall back to the document. The source says otherwise.)
  ⚠️ **A `429 text/html` is still HTML where code was asked**: a page across a deploy on a spent
  day gets a failed import with a status, which is the failure the app reports — but nothing
  here has seen what a service worker makes of it.
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
