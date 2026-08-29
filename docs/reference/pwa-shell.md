# The PWA shell

The installable web app around [the web target](web-target.md): a manifest, a hand-written
service worker, an update flow the reader controls, and an empty database that says whether it
was ever full.

Every figure below was taken on **2026-08-28**, on Windows 11, in **Edge 151** — headless for
everything except the install offer — against `npm run web:build` served by
`vite preview --config vite.web.config.ts --port 4173`, driven over CDP on port **9333**. The
wasm is a release build. **No new dependencies**: no `vite-plugin-pwa`, no Workbox.

---

> ## The reading somebody will want to undo, first
>
> **`crossOriginIsolated: false`, with the app working.**
>
> ```
> {"scope":"http://localhost:4173/","controlled":true,"isolated":false}
> ```
>
> [The spike](../superpowers/research/2026-08-27-wasm-core-spike.md) served the identical page
> with and without `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy:
> require-corp` and got identical results — install 65 ms against 50 ms, a 532.8 MB write in
> 3.3 s against 2.3 s, which is cache noise. **Cross-origin isolation is not required here**, so
> the service worker attaches neither header to anything, and the entire "works on first load,
> breaks on the second" class of bug does not exist in this design.
>
> Re-attaching them defensively costs every cross-origin image and script on the page and buys
> nothing. `swCore.test.ts` sweeps `sw.ts` for either name and fails the build if one appears.

---

## What is in the bundle

`vite.web.config.ts` installs one plugin, `webAssetsPlugin`, which emits into `dist-web/`:

| File | From |
| --- | --- |
| `manifest.webmanifest` | `manifestJson()` in `src/pwa/manifest.ts`, serialised at build time |
| `icons/maskable.svg` | **derived** from `public/mtg-grimoire-mark.svg`, not drawn again |
| `icons/mark-256.png`, `icons/mark-512.png` | `logos/png/`, read by the config |

and adds three lines to `<head>`: the manifest link, `<meta name="theme-color" content="#0C0D12">`
and an `apple-touch-icon` (iOS ignores the manifest's icons entirely).

**`index.html` is not touched and `vite.config.ts` is not touched**, so the desktop bundle is
byte-identical: `npm run build` leaves `dist/index.html` with **0** occurrences of
`rel="manifest"` and emits no `manifest.webmanifest` and no `icons/`.

**The maskable icon is derived and the derivation throws.** The master carries
`scale(0.9200)`; the maskable copy replaces it with `scale(0.8000)` and inserts a full-bleed
`#0C0D12` field after `</defs>`. `logos/README.md` says the master is the file to edit, so a
second hand-drawn copy would be a file guaranteed to rot — and if the master's transform is ever
rewritten, `maskableFromMark` throws rather than emitting a dark square nothing in a build log
would mention.

## The two caches

| Cache | Holds | Lifetime |
| --- | --- | --- |
| `grimoire-shell-<buildId>` | the whole bundle — **32 files** for this build | one per build; older ones deleted on activate |
| `grimoire-images` | card art, plus its own ledger at `/__grimoire_image_ledger__` | **never per-build** |

`staleShellCaches` is prefix-scoped rather than "everything else" for exactly that second row:
evicting 256 MB of card art on every deploy would undo the whole point of caching it. Observed
across the update below — before: `["grimoire-shell-daf7d2dc1bed6fbd"]`; with the new build
waiting: both; after the press: `["grimoire-shell-dce1bb81f7e05264"]` alone.

**The build id is a content hash of what is precached**, not a timestamp, so a rebuild of an
unchanged tree produces a byte-identical worker and prompts nobody. Two consecutive
`npm run web:build` runs on an unchanged tree both printed `272592bf5385507c`. Appending a
comment to `src/App.tsx` and rebuilding **also** printed the same id, because minification
strips it — the id is a fact about the *output*, which is the property that was wanted.

> ⚠️ **Two different workers can share a build id.** `sw.js` is excluded from its own precache,
> so a change to `sw.ts` alone leaves the id unchanged. The browser still installs the new worker
> (it compares `sw.js` bytes), and the reader is still prompted — but a `VERSION` message cannot
> tell those two builds apart. Observed. It is the right trade for the cache name; it is a trap
> for anyone using the id to identify a *worker*.

---

## `ignoreVary` is load-bearing, and only a browser could have found it

**Without it the offline shell is a blank page**, and everything else looks fine.

`Cache.match` honours the stored response's `Vary` by comparing the header it names on the
*stored request* against the incoming one. The dev and preview servers answer `/assets/*` with
`access-control-allow-origin` and **`vary: Origin`**. The precache is written by `cache.addAll`,
whose requests are `mode: "no-cors"`, `credentials: "omit"` and carry **no `Origin` header at
all**; the page's own module-script request — Vite emits `<script type="module" crossorigin>` —
carries `Origin: http://localhost:4173`. They disagree, so **every `/assets/` entry misses**.

The cached response, read out of Cache Storage:

```
vary: Origin
access-control-allow-origin: http://localhost:4173
content-type: text/javascript
```

**With the server up the miss is invisible**, which is what makes this worth writing down: the
`fetch` fallback is answered by the browser's HTTP cache, so the page works and the resource
timeline says `deliveryType: "cache"` rather than `"cache-storage"`. That one word is the whole
tell.

With the server stopped, before the fix:

| | `workerStart` | `deliveryType` | duration |
| --- | --- | --- | --- |
| navigation (`/`) | 33 | `cache-storage` | — |
| `/assets/index-*.js` | 0 | — | 2 326 ms |
| `/assets/index-*.css` | 0 | — | 2 310 ms |

`#root` was left at `childElementCount: 0` — a shell that serves its own document and nothing
else. After adding `{ ignoreVary: true }` to every lookup, same conditions:

| | `workerStart` | `deliveryType` |
| --- | --- | --- |
| navigation (`/`) | — | `cache-storage` |
| `/assets/index-*.js` | 19 | `cache-storage` |
| `/assets/index-*.css` | 19 | `cache-storage` |
| `/assets/geist-*.woff2` | 69 | `cache-storage` |

`#root` at **1**, heading "Build the card database". Ignoring `Vary` is right rather than
expedient: this cache holds one build's own static files under content-hashed paths, and there is
no second representation of any of them for a `Vary` to be choosing between. `swCore.test.ts`
sweeps `sw.ts` and fails on any Cache Storage lookup without it.

> **`/manifest.webmanifest` shows `workerStart: 0` offline and that is not a defect.** The
> manifest is fetched by the browser's own manifest loader rather than as a page subresource, so
> it does not pass through the service worker at all.

## What offline does and does not prove

The shell loads offline. **The app is not usable offline beyond that** — the corpus lives in
OPFS behind PR 4's Worker, and anything that reaches Scryfall still fails. What was verified is
that the document, the bundle, the stylesheet, the fonts and the wasm all come from Cache Storage
with the server stopped.

`/wasm/` is on the shell route beside `/assets/` and `/icons/`, and it is not in the plan this
was built from: on the web target the app **is** the wasm module, `scripts/build-wasm.mjs` writes
it into `web/public/`, so it never gets an `/assets/` path. Leaving it out makes an offline load
a shell that renders and then cannot open a database.

---

## The update flow, driven end to end

Two production builds, one waiting worker, one press.

| Step | Observed |
| --- | --- |
| Build **A** | `daf7d2dc1bed6fbd` — from the worker's own `VERSION` message |
| Build **B** | `dce1bb81f7e05264` after changing one string that survives minification |
| `registration.update()` | `waiting: true`, `waiting.state: "installed"`, both shell caches present |
| The bar | `role="status"` reading `"A new version is ready.Reload to update"` |
| **A plain reload, without pressing** | active worker **still `daf7d2dc1bed6fbd`**, still waiting, bar back |
| The press | active worker **`dce1bb81f7e05264`**, `waiting: false`, bar gone, `#root` at 1 |
| Afterwards | `caches: ["grimoire-shell-dce1bb81f7e05264"]` — the old shell deleted |
| One reload, not a loop | `performance.timeOrigin` unchanged over the following 12 s, `performance.now()` reaching 27 s in one document |

**The plain-reload row is the half of spec §5.4 that is easiest to lose and impossible to see in
a unit test.** A browser leaves the waiting worker waiting across a reload, so a reader who
ignores the bar keeps the build they started the session with. If that row ever reads **B**,
something is skipping the wait that should not be.

## The evicted corpus, forced

`Storage.clearDataForOrigin` with `storageTypes: "file_systems"` over CDP is a real eviction of
one storage system — the browser's own machinery rather than a page deleting its own files.

> **A page cannot stage this itself.** `removeEntry` on `OPFS:/mtg-grimoire` answers
> `NoModificationAllowedError` — the `opfs-sahpool` VFS holds exclusive access handles on all
> **64** files, and the refusal survives navigating away from the app and even a browser
> restart. That matches [web-target.md](web-target.md)'s "exclusivity is global rather than
> per-document" and 64/64 refused.

Immediately after the eviction:

```
opfs: []                                          <- the corpus is gone
mark: {"at":1787924849274,"cards":117606}          <- localStorage survived
caches: ["grimoire-shell-dce1bb81f7e05264"]        <- Cache Storage survived
```

which is spec §5.4's "shell loaded, corpus gone", exactly.

**On the next launch the reader is told the truth:**

> ### Your card data was cleared
> This browser removed the card database to free up space. It has to be downloaded again — about 75 MB.
>
> [Build it now]

> ⚠️ **In the *same* browser session as the eviction, they are not.** Navigating back to `/`
> without restarting the browser gave **"The card database would not open"** and
> `GetFileHandle(JsValue(InvalidStateError: An operation that depends on state cached in an
> interface object was made but the state had changed since it was read from disk))`. The pool
> cannot reinstall over a directory the browser deleted under it. That is PR 4's VFS rather than
> the shell's, it clears on the next launch, and it is **open**.

**The sentence stops short of promising the collection is safe, deliberately.**
`collection_entries`, `decks` and the rest live in the same SQLite file as `cards`, so an OPFS
eviction takes them too. The second clause becomes true only when a paired device can restore the
user tables (PR 7), and is owed against it.

### Where the eviction copy actually lives

**Not on `SyncProgress`, which is where the desktop half of it lives.** `WebBoot` mounts
`<App />` only once a corpus exists, and `SyncProgress` is inside `App` — so on the web target a
browser that threw the corpus away shows PR 4's `BuildCorpus` and never that screen. Both
components now take the same `reason` and change the same two lines.

## Persistence, install, and the number nobody may act on

Read live from the Settings panel after a real corpus build:

```
persistRecord: {"askedAt":1787924740607,"granted":false}
persistedNow:  false
corpusMark:    {"at":1787925194017,"cards":117606}
```

**`persist()` was refused, and asked exactly once.** The `askedAt` above is from the corpus build
*before* the eviction and was not asked again afterwards, which is the ask-once guard working
across an eviction. The answer is **recorded, not trusted**: a `true` would not have meant the
corpus was safe either, because Cache Storage and OPFS are evicted independently — which the
drill above demonstrates.

**The install offer does fire, in a headed browser.** Headless Edge never fires
`beforeinstallprompt` at all; headed, after a corpus build, the panel read:

> This browser can install the app, so it opens in its own window. — **[Install app]**

so `captureInstallPrompt` caught the event and called `preventDefault()` on it before Chrome drew
its own bar. **The install itself was not performed** — it would leave an installed app on the
machine — so whether an install turns `persisted()` into `true` is still owed.

**`estimate()` is printed and gates nothing.** The same panel read *"The browser estimates
743.2 MB in use"* against a database of 117 606 rows, beside the sentence *"Browsers report this
loosely; it is not a measurement of your database."* The spike's 647 MB-then-7 MB against one
532.8 MB file is why that sentence is there, and `WebStoragePanel.test.tsx` renders the panel at
7 MB and at 900 MB and asserts the same controls in both.

**The image cache row read `Nothing has been cached yet`** — corrected during this pass, from
`0.0 MB cached. The oldest are removed first when the limit is reached.`, which is a rule about
an eviction that cannot happen to nothing.

## The image route has a caller now — and its first exercise found a race

**Driven 2026-08-29** against the production web build (`npm run web:build`, served by
`vite preview` on 4173, Chromium via CDP), on a corpus built in the browser from Scryfall's bulk
file: **117 606 cards**.

### It works

`CardSummary` now carries the front face's `display` URL, `images.ts` answers it on the web build
instead of `mtgimg://`, and the wall draws. Measured on the search wall with no query:

- **63 `<img>` on the wall, 63 loaded, 0 broken, 0 on the `mtgimg://` scheme, 63 from
  `cards.scryfall.io`** — every one `672 × 936`, which is the `display` variant and not one of the
  other three.
- The service worker is **active and controlling** on the production build, and
  `grimoire-images` filled with **64 entries — the 63 pictures and the ledger**.
- **`caches.match` on a tile's own URL returns a hit.** The route that "had no caller yet" has
  one, and it stores what it is asked to.

⚠️ **`npm run web:dev` registers no service worker at all**, so none of the caching half is
reachable from the dev server — the first pass there showed `swActive: false` and zero caches
while the pictures drew perfectly. **A dev-server reading cannot answer any question about this
route.** Use `web:build` + `vite preview`.

### The bug: the ledger is a read-modify-write race, and it under-counts ~9×

**`image()` in `src/pwa/sw.ts` is not serialised**, and a wall of card art is the one workload
that guarantees the collision:

```ts
const ledger = admit(await readLedger(cache), request.url, bytes, Date.now());
await writeLedger(cache, await sweep(cache, ledger));
```

Every tile that misses runs that whole read-modify-write independently. A wall fires dozens at
once, they interleave at each `await`, and **each writes back a ledger built from the copy it read
before any of the others landed** — so all but the last are discarded. The cache-hit path has the
same shape one line up (`touch(await readLedger(cache), …)`).

**Measured from a genuinely empty `grimoire-images`, one wall load:**

| | |
| --- | --- |
| Pictures actually in the cache | **78** |
| Entries in the ledger (`size` and `used` alike) | **9** |
| What the ledger believes it is holding | 585 000 B |
| What it holds, by the ledger's own 65 KB average | 5 070 000 B |
| **Under-count** | **≈ 8.7×** |

**What that costs.** `DEFAULT_CAP_BYTES` is 256 MB, so at this ratio the cache would have to hold
something like **2.2 GB** before the ledger ever reported being full — the cap does not bite, and
the browser's own quota eviction takes over instead, on its own policy rather than on
least-recently-used. And when `sweep` does run it can only see the handful of files it knows
about, so it evicts from a tiny subset rather than from the true LRU set.

**This is exactly the failure `measuredSize`'s doc comment was written to prevent** — *"the cap
would never bite and the 256 MB would be a number in a settings panel and nowhere else"* —
arriving by a different route. That comment guards the *value* of one entry; nothing guarded the
number of entries that survive being written.

**It is PR 5's bug, not the DTO change's.** The image work simply gave the route its first caller,
which is what the 9a-era note *"the image route has no caller yet"* was quietly protecting.

**Why no test caught it.** `imageLedger.ts`'s functions — `admit`, `touch`, `sweep`, `evictions`,
`measuredSize` — are pure and correct in isolation, and `imageLedger.test.ts` exercises them that
way. The defect is in the *caller*'s interleaving, which no unit test over pure functions can
reach and which jsdom has no service worker to reproduce.

**Not fixed here, deliberately.** The remedy is a design choice rather than a patch — serialise
through a promise chain in the worker, batch the writes behind a debounce, or stop storing the
ledger as one blob and give each URL its own cache entry so concurrent writers cannot clobber one
another. Each has a different failure mode under eviction, and picking one belongs with its own
change and its own tests.

### One more thing, unmeasured

`useImageRetry` appends `?retry=N` to whatever `src` it holds, and a Scryfall URL already carries
`?<epoch>` — so a **retried** web tile requests `…webp?1783920578?retry=1`, where the second `?`
becomes part of the query value. Scryfall will very probably still serve it, but it is a second
cache key for one picture. Only reachable after an image error, so it was not hit on this pass and
is recorded rather than guessed at.

## Timings

| | |
| --- | --- |
| Corpus build, click to app rendered (headless, preview build) | **20 s** and **26 s** across two runs, 117 606 rows |
| Failed subresource, server stopped | ~2 310–2 348 ms per request |
| Shell precache | 32 files |
