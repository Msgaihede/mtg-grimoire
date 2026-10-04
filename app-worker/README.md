# `app-worker/` — the web app's hosting

A third Cloudflare Worker, beside `relay/` and `share-worker/`. It serves the light app's web
build — `dist-web/`, the page and the engine compiled to WASM — at **`https://mtg-grimoire.app`**,
the origin root. It is static assets, one file of response headers, and a script of a few lines.

**It is deployed there since 2026-10-04** — first at 12:47 UTC, from `main` at `d8c3779b`, with
every probe of step 0 asked of the real address a minute later. **The last deploy was 13:27 UTC
the same day, from `main` at `4929cc6e`**, rolled back at 13:28 and forward again at 13:30 to
see a rollback work — so that commit is what production serves, and `main` has moved past it
since. This paragraph said *nothing is deployed there* until that day. **Ask the host before you
believe it or its opposite.** This directory is source, configuration and a runbook; `wrangler
deploy` is Markus's, and each of those was run by an agent because he asked for it. The design is
[the light-app spec](../docs/superpowers/specs/2026-10-01-light-app-android-and-web-design.md) §6,
and the build it serves is [light-app.md](../docs/reference/light-app.md) §9 — whose §9.7 is the
deploy's own record, with what it has not proved.

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
  no card picture has yet been seen drawn under this policy.) **Answered since, twice**: the
  phase's own run drew them under this policy on `localhost` (light-app.md §9.6), and the run at
  the real origin, below, drew them there.
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
a menu; a card picture actually drawn; a service worker; any browser but this one. (**Of that
run.** The first three have been driven since — §9.6 on `localhost`, and the run below.)

**At the real origin, 2026-10-04, started 12:50 UTC** — three minutes after the first deploy.
The same headless Chrome, 154.0.8037.95 on Windows, a fresh temporary profile, listening only,
against `https://mtg-grimoire.app` serving engine build `6d63009f7fa1062b`. **One pass, one
run**; light-app.md §9.7 has every figure.

- **Zero policy violations** — on the page, in three sessions of the engine's Worker and in the
  service worker — with no request blocked or failed, no console error and nothing thrown. The
  console said `database open in OPFS — journal delete, corpus journal delete, schema 59`.
- **The first run against the real hosts, from this origin, finished**: 118,470 cards
  searchable at 21.4 s, and every launch feed in at 44.1 s, with the error log empty. **Every
  host in `connect-src` was asked and answered 200** — the engine's Worker asked
  `api.scryfall.com`, `data.scryfall.io`, `json.commanderspellbook.com` and
  `api.cardkingdom.com`, the service worker asked `cards.scryfall.io` — **and the app asked no
  host outside it.** That is the hosts' own CORS answer to this origin, which no fixture and no
  `localhost` could give.
- **Card pictures were drawn under the policy as the host sends it**: the phone face's first
  wall and a typed search, every picture asked of `/mtgimg/display/…` on this origin and
  answered 200 by the service worker, each stored as `image/webp`; and the desktop face's wall
  at 1280 × 800. An uncached picture took a median of 995 ms against 402 ms in §9.6's local
  run — Scryfall's share of that not separated.
- **The service worker took control on the first visit** and precached the shell, every request
  a 200; a deep link to `/decks` in the same profile was answered by it; and **a launch with no
  name resolvable opened the app**, with its cached pictures drawn and *Retrying…* over the
  worker's 502 for one never cached.
- **The document the browser was served was the built one, byte for byte**, with one `<script>`
  in the HTML and in the live DOM, and none of the zone features' marks in either.
- **Chrome was sent `zstd`, not the brotli `curl` was**: the module was 2,176,146 bytes on the
  wire.
- **Settings → Sync → *Pair a device*** drew the engine's refusal sentence and made **no
  cross-origin request** — so the relay's absence from `connect-src` was never what a reader
  met.

**Not driven in that pass**, and driven later the same day, next: the update flow, which needed
a second deploy; a second tab; a launch after storage was cleared; decks, import and export, a
context menu, an *Open on …* link; the engine asked to fetch with no network.

**The rest, the same day** — headless Chrome 154 again, one fresh profile, the real hosts, on
the first deploy's build; then one tab held open across the three deploys of *Rolling back*.
light-app.md §9.7 has every figure. **Across both sessions: no policy violation, no request
blocked or failed while online, and nothing thrown.**

- **A second tab is told at once and starts no engine** — at 130 ms with the first tab in the
  middle of its first run, at 87 ms with it idle — and its *Reload* opens the app once the
  first has closed.
- **A reload that lands inside the real card sync's finish opens again**, on the fifth ask,
  about four seconds after the first. ⚠️ The interrupted finish left no cards, so the new
  document downloaded the card file again.
- **A launch after the browser cleared the app's storage** drew its notice and rebuilt the
  corpus by itself.
- **Every reader task on both faces worked**, decks, import, export and the *Open on …* links
  among them.
- **With no network the app opens from the service worker**, and a refresh the reader presses
  fails with an alert and a line in the log. ⚠️ The alert is the engine's raw words — *http
  request failed: error sending request* — not a sentence written for a reader.
- **Nothing stands in the way of an install by Chrome's own check**: no installability error,
  the manifest served as `application/manifest+json` with the policy, every icon a 200. No
  install was made; headless Chrome has no install UI.
- **A build deployed under an open page is offered, and taken only on the reader's press** —
  three times, with the reader's data intact each time. *What a deploy changes for a reader*,
  below, has what it cost.
- **`/favicon.ico` answers 404.** The app's document names an SVG icon, so a browser asks for
  the `.ico` only when it opens a document of this origin that is not the app's — and by the
  split in *What it answers* that miss is the script's, a Worker request each time.

**And outside that Chrome: the owner used the live site in Firefox that day** and reported one
sentence — *"it works fine. multiple tabs locks the user out until the first tab is closed."*
No version and no figure; it is the only word there is from a second engine.

**Still not driven at the real origin**: the app's *own* check for a new build — every check
was the driver calling `registration.update()`; a deploy that renames a chunk; an installed
app; Safari; a phone.

## Deploying

⚠️ **No agent runs `wrangler deploy`, or any wrangler command that reaches Cloudflare.** That is
the repo owner's, as it is for the other two Workers. `wrangler` is not a dependency of this
repository; `npx` fetches it. **The 2026-10-04 deploy was run by an agent because Markus asked
for it in chat**, as he did for the relay's on 2026-10-01 — and **the ask is per deploy**: it
lifted this rule for that one deploy and left it standing for the next. The second deploy that
day, and the rollback and roll-forward after it, were asked for again — he approved a marker
deploy and a rollback test through the question tool — and nothing else was.

### Step 0 — ask the host, never a document

`relay/README.md` was wrong twice in one week about what was deployed, and five files once agreed
the relay did not exist while it was answering requests. The only sentence that cannot rot is a
`curl`. **The *Answered* column is what the real address said on 2026-10-04 at 12:48 UTC** — a
minute after the first deploy, asked with `curl` from one machine in Denmark, of version
`cdee3c1c-d3ae-4246-8e8a-c50eb3025152`: `main` at `d8c3779b`, engine build id `6d63009f7fa1062b`.
(Until that day the column read *not yet run* in every row, and this paragraph said there was
nothing at the address to ask.) **It is that minute's answer and no later one's.** Run them again
before believing this file or its opposite, and after every deploy, and write the answers in here
with the date.

**Production has moved once since the column was written**: version
`f724bbc1-9853-4978-9ffe-8b3c0af6c339`, `main` at `4929cc6e`, the same engine build. Probes 1–11
and 14–18 were asked of it after the roll forward, and **each answered as the
column says** — the policy equal, the 304 carrying it, the document equal to the built one —
with the module's brotli transfer 2,139,182 bytes that time.

```
A=https://mtg-grimoire.app
B=$(ls ../dist-web/wasm)                       # the engine's build id, from the build deployed
J=$(ls ../dist-web/assets | grep -m1 '^index-.*\.js$')
W=$(ls ../dist-web/assets | grep -m1 '^worker-.*\.js$')   # the engine's Worker
H='^HTTP|content-type|cache-control|content-security-policy|x-content-type|referrer-policy|content-encoding|^etag'
```

| # | Probe | Should answer | Answered |
| --- | --- | --- | --- |
| 1 | `curl -s -o /dev/null -D - "$A/" \| grep -iE "$H"` | `200`, `text/html`, `cache-control: no-cache`, `nosniff`, `strict-origin-when-cross-origin`, and the policy — **byte for byte the line in `_headers`** | **2026-10-04** — `200`, `text/html` with no charset, `no-cache`, `nosniff`, `strict-origin-when-cross-origin`, and the policy equal byte for byte |
| 2 | `curl -s -o /dev/null -D - -H "Sec-Fetch-Mode: navigate" "$A/decks/12" \| grep -iE "$H"` | `200`, `text/html`, **and the same policy line and `cache-control: no-cache`** — the fallback document, answered at the edge with the script not run. This is the document every deep link and every reload of one gets; a policy on `/` alone would not be a policy | **2026-10-04** — `200`, `text/html`, `no-cache`, the policy equal byte for byte, and probe 1's `ETag` |
| 3 | `curl -s -w " %{http_code} %{content_type}\n" "$A/decks/12"` | `Not found 404 text/plain; charset=utf-8` — curl accepts `*/*`, so the script refuses it | **2026-10-04** — `Not found 404 text/plain; charset=utf-8` |
| 4 | `curl -s -o /dev/null -D - -H "Accept: text/html" "$A/decks/12" \| grep -iE "$H"` | `200`, `text/html`, the policy and `no-cache` — the script, through the binding. The docs do not say `_headers` reaches this one; the asset worker's source does (`attachCustomHeaders` wraps every response, matched on the path the script asked — `/`) | **2026-10-04** — `200`, `text/html`, `no-cache`, the policy equal byte for byte, and probe 1's `ETag` again — so `_headers` does reach it |
| 5 | `curl -s -w " %{http_code} %{content_type}\n" "$A/assets/nope.js"` | `Not found 404 text/plain; charset=utf-8`. ⚠️ **`200 text/html` here means the script is not deployed** and every renamed chunk is being answered with the document | **2026-10-04** — `Not found 404 text/plain; charset=utf-8` |
| 6 | `curl -s -o /dev/null -w "%{http_code} %{content_type}\n" -H "Sec-Fetch-Mode: navigate" "$A/assets/nope.js"` | `200 text/html` — Cloudflare's rule for a navigation, harmless | **2026-10-04** — `200 text/html` |
| 7 | `curl -s -o /dev/null -D - "$A/wasm/$B/grimoire_web_bg.wasm" \| grep -iE "$H"` | `200`, **`application/wasm`**, `public, max-age=31536000, immutable`, and the policy | **2026-10-04** — `200`, `application/wasm`, `public, max-age=31536000, immutable`, the policy equal byte for byte |
| 8 | the same with `-H "Accept-Encoding: br, gzip"` | a `content-encoding` — `application/wasm` is on Cloudflare's default list. **Record which**: it is the size a reader downloads | **2026-10-04** — **`content-encoding: br`, 2,139,023 bytes on the wire** for a module of 6,767,338; 2,373,483 when only gzip is offered. The `ETag` turns weak, `W/"…"`, on the compressed response; the caching and the policy are probe 7's. ⚠️ A browser that offers `zstd` is sent that instead — Chrome 154 downloaded 2,176,146 bytes the same day |
| 9 | `curl -s -o /dev/null -D - "$A/assets/$J" \| grep -iE "$H"` | `200`, a JavaScript MIME type (wrangler's table says `application/javascript`; the preview says `text/javascript`; a browser takes either), a year, immutable — and **not** `no-cache, public, …`, which is the detach not working | **2026-10-04** — `200`, `text/javascript` with no charset, `public, max-age=31536000, immutable` — one value — the policy equal byte for byte |
| 10 | `curl -s -o /dev/null -D - "$A/sw.js" \| grep -iE "$H"` | `200`, a JavaScript MIME type, **`cache-control: no-cache`** — one value — and the policy: the service worker's own `fetch` of a card picture is held to the line on *this* response. ⚠️ `404` means the build deployed has no service worker (`web:build` writes `sw.js` last) | **2026-10-04** — `200`, `text/javascript`, `no-cache` — one value — the policy equal byte for byte |
| 11 | `curl -s -o /dev/null -w "%{http_code}\n" "$A/_headers"` | `404` — the file is parsed, not served, which is why a service worker's precache list must leave it out | **2026-10-04** — `404` |
| 12 | `curl -s -o /dev/null -w "%{http_code}\n" https://mtg-grimoire-app.denmark-east.workers.dev/` | **not `200`** — there is no second origin | **2026-10-04** — `404` |
| 13 | `curl -sI http://mtg-grimoire.app/ \| head -3` | a redirect to `https`, if the zone has *Always Use HTTPS* on. A browser never asks: `.app` is HSTS-preloaded | **2026-10-04** — ⚠️ **`HTTP/1.1 200 OK`, `text/html`, and no redirect.** *Always Use HTTPS* is off on the zone, so a `curl http://` is handed the document in the clear. Turning it on is the owner's |
| 14 | `curl -s -o /dev/null -D - -H "Sec-Fetch-Mode: no-cors" -H "Accept: image/avif,image/webp,image/*,*/*;q=0.8" "$A/mtgimg/display/abc/0" \| grep -iE "$H"` | `404`, `text/plain`, **`cache-control: no-store`** — an `<img>`'s request, as a page no service worker controls makes it. ⚠️ `200 text/html` is the document where a picture was asked | **2026-10-04** — `404`, `text/plain; charset=utf-8`, `no-store`, `nosniff`, and no policy line: the script's own three headers, which `_headers` does not reach |
| 15 | the same with `-H "Accept: text/html"` and no `Sec-Fetch-Mode` | `404` again — the script holds no place under `/mtgimg/` | **2026-10-04** — `404`, `text/plain; charset=utf-8`, `no-store`, as probe 14's |
| 16 | `curl -s -o /dev/null -D - "$A/icons/icon-192.png" \| grep -iE "$H"` | `200`, `image/png`, `cache-control: no-cache` | **2026-10-04** — `200`, `image/png`, `no-cache`, the policy equal byte for byte |
| 17 | `curl -s -o /dev/null -D - "$A/assets/$W" \| grep -iE "$H"` | `200`, a JavaScript MIME type, **`cache-control: no-cache`** — one value, not a year and not three joined — the policy, and an `etag` | **2026-10-04** — `200`, `text/javascript`, `no-cache` — one value — the policy equal byte for byte, and a strong `ETag` |
| 18 | `E=$(curl -s -o /dev/null -D - "$A/assets/$W" \| grep -i '^etag' \| cut -d' ' -f2 \| tr -d '\r')`, then `curl -s -o /dev/null -D - -H "If-None-Match: $E" "$A/assets/$W" \| grep -iE "$H"` | **`304`, with the policy line on it.** This is the response that re-governs a returning reader's engine after a change to `_headers`; a 304 without the policy leaves the old one in force (measured) | **2026-10-04** — **`304 Not Modified`, with the policy on it, equal byte for byte**, `no-cache`, and probe 17's `ETag` |

**Beside the table, the same minute**: the document served — to `-H "Sec-Fetch-Mode: navigate"`
and to a plain `GET /` — was byte for byte `dist-web/index.html`; and `www.mtg-grimoire.app` did
not resolve, so there is no third name to be a second origin. **Two things the table's *should*
column did not foresee, neither a fault**: the edge sends `text/html` and `text/javascript` with
no `charset` (the document declares its own in a `<meta>`), where `wrangler dev` adds
`; charset=utf-8`; and plain `http` is answered, not redirected — probe 13.

Then open the address in a browser with its console open: no policy violation, the app past its
gate, and `database open in OPFS` on the console. That is the probe no `curl` can make. ⚠️ **Look
at the document's source while there**: a `<script>` the build did not write is a zone feature
rewriting the page — *Before the first deploy*, below. **Made on 2026-10-04 at 12:50 UTC**, in
headless Chrome 154.0.8037.95: no violation, the app past its gate, that console line, and one
`<script>` in the source and in the live DOM — *What the browser said under it* has the run.

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
   on the apex the moment it finishes. **Run once, on 2026-10-04, as `wrangler dev --local`**
   (wrangler 4.146.0, port 8787), over the build deployed later that day: probes 1–11 and 14–18
   each answered as the table says it should, and the document served equalled the built one.
   Probes 12 and 13 have nothing local to ask. **What differed from the edge, none of it a
   fault**: text types carried `; charset=utf-8`, every `ETag` was another value for the same
   bytes, the compressed module kept a strong one, and its brotli transfer was 1,986,553 bytes
   against the edge's 2,139,023 — so the local figure is not the size a reader downloads.
   `--local` reaches nothing, which is what the rule above turns on; if it asks to log in, it is
   not in local mode: stop.
6. **Before the first deploy, look at the zone** — *Before the first deploy*, below.
7. **`npx wrangler deploy`**, from `app-worker/` — `--dry-run` first, which uploads nothing. Read
   what it prints: the files it read and uploaded, the binding, the custom domain it attached and
   the version id. ⚠️ **It does not say how many `_headers` rules it parsed.** This step told its
   reader to read that count until 2026-10-04, when wrangler 4.146.0 printed no such line.
   **The proof the rules were taken is step 8's probes 1, 7, 9, 10 and 17 answering with the
   `Cache-Control` each should** — the default, the two trees and the two files. The first
   deploy created the DNS record and the certificate for `mtg-grimoire.app`: the zone held no
   DNS record at all that day, so nothing was in the apex's way, and **the apex answered 200
   with the document on the first request after the command returned** — no wait for the
   certificate was observed, which is one deploy's experience and not a figure. ⚠️ A Custom
   Domain cannot be created over a hostname that already has a CNAME record; if the domain is
   ever detached and attached again, a record on the apex has to go first.
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
"fixed" by loosening the policy. **The zone was read through Cloudflare's API on 2026-10-04,
before the first deploy** — read-only, by the agent that then deployed — and the last column is
what it said. (This sentence read *nobody writing this has seen the zone* until then.) **A
setting is the owner's to change on any day, so the column is that day's and no later one's**;
these are the ones the documentation names, each to be confirmed **off** for `mtg-grimoire.app`:

| Feature | What it does to the page | Where the docs put it | Read 2026-10-04 |
| --- | --- | --- | --- |
| **Web Analytics, automatic setup** | injects `<script src="https://static.cloudflareinsights.com/beacon.min.js">` into every proxied page of the zone | `web-analytics/` — the dashboard's Web Analytics section, *Manage Site* for the hostname. ⚠️ Its *exclude EU visitors* option means an owner in Denmark may never be served the script that every reader outside the EU is — check the setting, not the page | **no Web Analytics site on the account** |
| **Rocket Loader** | rewrites `<script>` tags and adds its own loader | `speed/optimization/content/rocket-loader/` — "If you have a Content Security Policy … you will need to update your headers" | **off** |
| **Email Address Obfuscation** | rewrites e-mail addresses it finds in the HTML — idle while the document has none, which is today | named beside Rocket Loader on that page as using non-standard tags | ⚠️ **on** — the zone's default, and idle: the built document contains no `@`. Left as found; it is the owner's setting |
| **JavaScript Detections** (bot settings) | injects an **inline** script; the docs quote the console error `script-src 'self'` produces. It also strips the `ETag` from HTML it touches | `cloudflare-challenges/challenge-types/javascript-detections/` | **off** (`enable_js`), and bot fight mode off |

None of them is turned on by anything in this repository; each is a setting of the zone. **The check that cannot be fooled** is the document a reader gets: `curl -s
-H "Sec-Fetch-Mode: navigate" https://mtg-grimoire.app/ | diff - ../dist-web/index.html` — from
outside the EU as well, if Web Analytics was ever on — must print nothing. **It printed nothing
on 2026-10-04**, for the navigation and for a plain `GET /` alike — asked from Denmark and from
nowhere else.

**The one of the four that is on is the one to watch.** Email Address Obfuscation does nothing
to a document with no address in it, and nothing in this repository keeps one out: the day the
light entry's HTML carries an `@`, the served document stops equalling the built one, and that
`diff` is the only thing that would say so.

**What else the zone said that day**: active, on the Free plan, with **no DNS record at all**
before the deploy; SSL mode `full`; brotli on; **Always Use HTTPS off**, which is probe 13's
answer; no HSTS header configured at the zone, `.app` being HSTS-preloaded as a TLD; and the
account's Workers were `mtg-grimoire-relay` and `mtg-grimoire-share`, neither with a custom
domain. Nothing was changed.

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
- **Measured on 2026-10-04, three times, at the real origin**: exactly that deploy — two comment
  lines in `_headers`, so `_headers` and `sw.js` were the only files that differed — under one
  open tab in headless Chrome 154 with a reader's data in it.
  - **The bar was drawn 648–689 ms after the check**, with the new worker `installed` and
    waiting and both builds' shell caches held. A reload while it waited stayed on the old
    build, with the bar back; *Not now* put the bar away and the next load brought it back.
  - **The install downloaded nothing again**: 43 requests of about 810–845 bytes each, 35 KB in
    all, the engine's module 843 bytes of it — and no request to any other host.
  - **The press** gave a new document about 2.6 s later, with one shell cache — the new
    build's — the reader's deck, collection and wishlist intact, and the corpus as it was.
  - ⚠️ **The check was the driver's `registration.update()`, never the app's own.** Headless
    Chrome would not fire `visibilitychange`, and the app asks at most hourly. That a reader is
    offered a build without anybody calling for it is unseen here.
  - ⚠️ **No chunk was renamed**, so the first bullet above — a page meeting a renamed chunk
    across a deploy — is still unseen at the real host.
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

**Run once, on 2026-10-04, and then run again to go forward.** The owner approved a rollback
test; this section said *none of this has been run* until then. Two builds that differ in
`_headers` and `sw.js` alone — the first deploy, and a marker deployed at 13:27 UTC.

| UTC | Command | What the host's `sw.js` then was |
| --- | --- | --- |
| 13:28:58 | `wrangler rollback <the first version's id> -m … -y` | the marker's at the first look, **the first deploy's five seconds later** |
| 13:30:22 | `wrangler rollback <the marker's id>` | the first deploy's at the first two looks, 5 s apart; the marker's at the third |

- **A rollback does bring a version's files back with it**, within seconds.
- **`rollback` takes any version id**, so it rolls forward too — which is how production came to
  end on the marker without a third upload.
- **Non-interactive, `-y` prints *Using fallback value in non-interactive context: yes***, and
  the command warns that it *will not rollback any of the bound resources*. This Worker binds
  nothing but its assets, which are the version's.
- `npx wrangler deployments list` shows the three deployments with their messages.
- **To the page that was open it was an update like any other**: the first deploy's `sw.js` is
  different bytes from the marker's, so the bar offered it, and until the press the page went
  on working on the build it had — *What a deploy changes for a reader*, above.

⚠️ **What that run was not**: a rollback of a build that renamed chunks, or of one that shipped a
schema rung. Neither build changed the page's code or the database.

**It does not roll back a reader's data.** If a build migrated a schema in OPFS, the build before
it is now looking at a database from its future. A page-only fault is safe to roll back; a build
that shipped a schema rung is fixed forwards.

### What is settled, what `wrangler dev` settles, and what only a deploy can

**Every probe in the table has been run — on 2026-10-04, locally where it can be asked and then
at the real address.** This section opened *nothing in the probe table has been run, anywhere*
until that day. The questions are still not all the same kind, and most of them do not need a
public address — which is what step 5 is for on every deploy after the first.

**Read off Cloudflare's own source** (`cloudflare/workers-sdk`, `packages/workers-shared`, at
`f025bbfd`, 2026-10-03) — the asset worker and the router worker that `wrangler dev` runs
locally and Cloudflare runs in front of a Worker with assets. Read first, and **since
2026-10-04 run**, by the probes named at each:

- **`_headers` reaches the fallback document and a document the script fetched through the
  binding.** `handleRequest` (asset-worker) wraps *every* response it returns in
  `attachCustomHeaders`, matched on the path of the request it was given — the 200, the
  single-page fallback, the 304. (Probes 2, 4 and 18.)
- **The navigation split.** `canFetch` keeps `not_found_handling` only when the request carries
  `Sec-Fetch-Mode: navigate` (and the flag is on); for every other request a miss is "no asset",
  and the router sends it to the script. (Probes 2, 3, 5, 6, 14 and 15.)
- **Detach, then set, yields one value** (probes 7, 9, 10 and 17); rules apply in the file's
  order; two rules for one path are one rule, the last (`constructHeaders` stores them by path);
  a rule with nothing under it is dropped. **Those last two are still read and not run** —
  `src/headers.ts` refuses a file that would show either, so no build can carry one to a host.

**Step 5, `wrangler dev`, turned each of those from read to run** — the navigation split, the
headers on both documents, the detach, the Worker chunk's 304, `/_headers`, the content types —
with nothing public, and the edge then answered the same.

**Only a deploy could settle these, and the three on 2026-10-04 settled each but the preview
address**:

- **The certificate and the apex**: ~~how long issuance takes, and whether a record was in the
  way~~ — no record was (the zone had none), and the apex answered 200 on the first request
  after the deploy returned. No wait was observed; no duration was measured.
- **What the edge compresses the module with** (probe 8), and so what a first visit downloads:
  **brotli, 2,139,023 bytes on the wire** for the 6,767,338-byte module, and 2,373,483 where
  only gzip is offered. ⚠️ **That is `curl`'s answer and not a reader's**: Chrome 154 offers
  `zstd`, the edge chose it, and the module was **2,176,146 bytes** on the wire there — the
  figure for a first visit in that browser. (This line carried an earlier module's figures
  until the deploy — 8,623,589 bytes, and 3.07 MB gzipped by Vite's report.)
- **That neither alternate origin answers**: the `workers.dev` name is a `404` (probe 12), and
  `www` does not resolve. ⚠️ **A per-version preview address was not asked** — the table has no
  probe for one, so `preview_urls: false` is still the configuration's word and not the host's.
- **What the zone does to plain `http`** (probe 13): it answers it — `200`, the document, no
  redirect — because *Always Use HTTPS* is off.
- **What the zone's own features do to the document** — the table above: nothing, for the
  document asked from one country on one day.
- **That a rollback brings a version's files back with it.** ~~The limits are stated per Worker
  version, which says so; nobody has watched it.~~ **It does** — the host served the earlier
  version's `sw.js` five seconds after the command, on 2026-10-04 (*Rolling back*, above).
- **The policy against the real hosts, from this origin** — which `curl` cannot ask, and a
  browser did the same day (*What the browser said under it*, above): **every host in
  `connect-src` was asked from a page at `mtg-grimoire.app` and answered 200, the app asked no
  other host, and nothing was refused.** One run, in one Chrome.

**And no deploy by itself settles these**, which are a browser's and a later day's: any browser
but one Chrome on Windows, and any phone — the policy and the engine have met no Safari, and of
Firefox there is the owner's one sentence that it works and nothing measured; and a spent
free-plan day. (This paragraph ended on a card picture through the service worker as the one
thing `img-src` had yet to draw. It has drawn them — on `localhost` in light-app.md §9.6, and at
the real origin on 2026-10-04.)

**A deploy over a page that is open with its service worker in control was on that list, and
has been seen** — three times that day, *What a deploy changes for a reader*. **Two halves of
it are still open, and each needs a deploy to close**:

- **The app's own check.** Every handover began with the driver calling
  `registration.update()`.
- **A renamed chunk.** No build deployed so far differs from another in the page's code. `main`
  has moved past production by a change that does, so a deploy of it as it stands would be the
  first to rename one.

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
  matter of broken pictures. Nobody has counted it. (**One first visit has been since**, at the
  real origin on 2026-10-04: none of the page's requests to this origin was a 404. The worker
  was in control at 1,553 ms, and a fresh profile has no card to draw until its corpus is built,
  21.4 s in. One run, in one Chrome; a returning reader whose worker was evicted is the case it
  does not cover.)
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
